import type { Filters, LogRecord, LogSummary, Page, Stats } from '@gw/shared';
import { DatabaseSync, type SqliteDatabase } from './sqlite.ts';

/**
 * Storage behind a narrow interface, so "SQLite or Postgres?" stays a
 * reversible decision rather than an architectural one. Swapping the
 * implementation is an afternoon; nothing above this file knows which it is.
 */
export type { Filters, Page, LogSummary, Stats } from '@gw/shared';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  api_key_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  path TEXT NOT NULL,
  model TEXT,
  is_stream INTEGER NOT NULL,
  request_headers TEXT NOT NULL,
  request_body TEXT,
  request_body_truncated INTEGER NOT NULL,
  status INTEGER NOT NULL,
  response_headers TEXT NOT NULL,
  response_body TEXT,
  response_body_truncated INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  ttft_ms INTEGER,
  chunk_count INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  terminal_state TEXT NOT NULL,
  finish_reason TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS ix_logs_key_time ON request_logs(api_key_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_logs_key_status ON request_logs(api_key_id, status);
`;

export class LogStore {
  #db: SqliteDatabase;

  constructor(path = 'gateway.db') {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec(SCHEMA);
  }

  /**
   * INSERT OR REPLACE, not INSERT.
   *
   * The gateway's sink retries a failed batch, which makes delivery
   * at-least-once. An idempotent write on a caller-supplied id turns that back
   * into effectively-once without a dedupe table.
   */
  insert(records: LogRecord[]): void {
    const stmt = this.#db.prepare(`
      INSERT OR REPLACE INTO request_logs VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`);
    for (const r of records) {
      stmt.run(
        r.id,
        r.apiKeyId,
        r.apiKeyName,
        r.startedAt,
        r.method,
        r.url,
        r.path,
        r.model,
        r.isStream ? 1 : 0,
        JSON.stringify(r.requestHeaders),
        r.requestBody,
        r.requestBodyTruncated ? 1 : 0,
        r.status,
        JSON.stringify(r.responseHeaders),
        r.responseBody,
        r.responseBodyTruncated ? 1 : 0,
        r.durationMs,
        r.ttftMs,
        r.chunkCount,
        r.promptTokens,
        r.completionTokens,
        r.terminalState,
        r.finishReason,
        r.error,
      );
    }
  }

  query(apiKeyId: string, filters: Filters, cursor: string | null, limit = 50): Page {
    const where: string[] = ['api_key_id = ?'];
    const params: Array<string | number> = [apiKeyId];

    if (filters.methods?.length) {
      where.push(`method IN (${filters.methods.map(() => '?').join(',')})`);
      params.push(...filters.methods);
    }
    if (filters.terminalStates?.length) {
      where.push(`terminal_state IN (${filters.terminalStates.map(() => '?').join(',')})`);
      params.push(...filters.terminalStates);
    }
    if (filters.models?.length) {
      where.push(`model IN (${filters.models.map(() => '?').join(',')})`);
      params.push(...filters.models);
    }
    if (filters.statusClasses?.length) {
      const ranges = filters.statusClasses.map(() => '(status >= ? AND status < ?)');
      where.push(`(${ranges.join(' OR ')})`);
      for (const cls of filters.statusClasses) {
        const base = Number(cls[0]) * 100;
        params.push(base, base + 100);
      }
    }
    if (filters.q) {
      where.push('url LIKE ?');
      params.push(`%${filters.q}%`);
    }
    if (cursor) {
      // Keyset pagination: stable under inserts, unlike OFFSET.
      const [ts, id] = cursor.split('|');
      where.push('(started_at < ? OR (started_at = ? AND id < ?))');
      params.push(Number(ts), Number(ts), id!);
    }

    const rows = this.#db
      .prepare(
        `SELECT id, started_at, method, path, model, is_stream, status, duration_ms,
                ttft_ms, prompt_tokens, completion_tokens, terminal_state, api_key_name
         FROM request_logs
         WHERE ${where.join(' AND ')}
         ORDER BY started_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit + 1) as any[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      rows: page.map(toSummary),
      nextCursor: hasMore && last ? `${last.started_at}|${last.id}` : null,
    };
  }

  get(apiKeyId: string, id: string): LogRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM request_logs WHERE api_key_id = ? AND id = ?')
      .get(apiKeyId, id) as any;
    return row ? toRecord(row) : null;
  }

  stats(apiKeyId: string, sinceMs: number, untilMs = Number.MAX_SAFE_INTEGER): Stats {
    const agg = this.#db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN terminal_state != 'completed' THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens
         FROM request_logs WHERE api_key_id = ? AND started_at >= ? AND started_at < ?`,
      )
      .get(apiKeyId, sinceMs, untilMs) as any;

    const durations = (
      this.#db
        .prepare(
          `SELECT duration_ms FROM request_logs
           WHERE api_key_id = ? AND started_at >= ? AND started_at < ?
           ORDER BY duration_ms ASC LIMIT 5000`,
        )
        .all(apiKeyId, sinceMs, untilMs) as any[]
    ).map((r) => r.duration_ms as number);

    const at = (p: number) =>
      durations.length === 0 ? 0 : durations[Math.min(durations.length - 1, Math.floor(durations.length * p))]!;

    return {
      total: Number(agg.total ?? 0),
      errors: Number(agg.errors ?? 0),
      p50: at(0.5),
      p95: at(0.95),
      promptTokens: Number(agg.prompt_tokens ?? 0),
      completionTokens: Number(agg.completion_tokens ?? 0),
    };
  }

  models(apiKeyId: string): string[] {
    return (
      this.#db
        .prepare(
          'SELECT DISTINCT model FROM request_logs WHERE api_key_id = ? AND model IS NOT NULL ORDER BY model',
        )
        .all(apiKeyId) as any[]
    ).map((r) => r.model as string);
  }

  close(): void {
    this.#db.close();
  }
}

function toSummary(row: any): LogSummary {
  return {
    id: row.id,
    startedAt: row.started_at,
    method: row.method,
    path: row.path,
    model: row.model,
    isStream: row.is_stream === 1,
    status: row.status,
    durationMs: row.duration_ms,
    ttftMs: row.ttft_ms,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    terminalState: row.terminal_state,
    apiKeyName: row.api_key_name,
  };
}

function toRecord(row: any): LogRecord {
  return {
    id: row.id,
    apiKeyId: row.api_key_id,
    apiKeyName: row.api_key_name,
    startedAt: row.started_at,
    method: row.method,
    url: row.url,
    path: row.path,
    model: row.model,
    isStream: row.is_stream === 1,
    requestHeaders: JSON.parse(row.request_headers),
    requestBody: row.request_body,
    requestBodyTruncated: row.request_body_truncated === 1,
    status: row.status,
    responseHeaders: JSON.parse(row.response_headers),
    responseBody: row.response_body,
    responseBodyTruncated: row.response_body_truncated === 1,
    durationMs: row.duration_ms,
    ttftMs: row.ttft_ms,
    chunkCount: row.chunk_count,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    terminalState: row.terminal_state,
    finishReason: row.finish_reason,
    error: row.error,
  };
}

/**
 * The same filter semantics as `query`, in JS.
 *
 * Live rows are pushed over the WebSocket without touching the database, so the
 * two must agree — otherwise a filtered view shows rows on arrival that vanish
 * on refresh.
 */
export function matchesFilters(row: LogSummary, filters: Filters, url = ''): boolean {
  if (filters.methods?.length && !filters.methods.includes(row.method)) return false;
  if (filters.terminalStates?.length && !filters.terminalStates.includes(row.terminalState)) {
    return false;
  }
  if (filters.models?.length && (!row.model || !filters.models.includes(row.model))) return false;
  if (filters.statusClasses?.length) {
    const cls = `${Math.floor(row.status / 100)}xx`;
    if (!filters.statusClasses.includes(cls)) return false;
  }
  if (filters.q && !url.toLowerCase().includes(filters.q.toLowerCase())) return false;
  return true;
}

export function summarise(record: LogRecord): LogSummary {
  return {
    id: record.id,
    startedAt: record.startedAt,
    method: record.method,
    path: record.path,
    model: record.model,
    isStream: record.isStream,
    status: record.status,
    durationMs: record.durationMs,
    ttftMs: record.ttftMs,
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
    terminalState: record.terminalState,
    apiKeyName: record.apiKeyName,
  };
}
