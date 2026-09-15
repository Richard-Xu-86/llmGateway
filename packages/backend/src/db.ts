import type { Bucket, Filters, LogRecord, LogSummary, Page, Series, Stats } from '@gw/shared';
import { SERIES_BUCKETS } from '@gw/shared';
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
  upstream_url TEXT,
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
    this.#migrate();
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
   * so a new column in SCHEMA never reaches an existing database — the next
   * insert just fails. Adding columns idempotently here means someone who has
   * been running this since yesterday keeps their rows.
   *
   * Deliberately minimal: additive columns only, no data rewriting. Anything
   * beyond that wants a real migration tool with ordered, recorded steps.
   */
  #migrate(): void {
    const columns = new Set(
      (this.#db.prepare('PRAGMA table_info(request_logs)').all() as any[]).map(
        (c) => c.name as string,
      ),
    );
    if (!columns.has('upstream_url')) {
      this.#db.exec('ALTER TABLE request_logs ADD COLUMN upstream_url TEXT');
    }
  }

  /**
   * INSERT OR REPLACE, not INSERT.
   *
   * The gateway's sink retries a failed batch, which makes delivery
   * at-least-once. An idempotent write on a caller-supplied id turns that back
   * into effectively-once without a dedupe table.
   *
   * The whole batch runs in one transaction. Without it each row is its own
   * implicit transaction and its own WAL commit, which is an order of magnitude
   * slower and leaves a failed batch half-applied.
   */
  insert(records: LogRecord[]): void {
    if (records.length === 0) return;
    // Columns named rather than positional: a bare VALUES(...) list silently
    // shifts every field by one the moment a column is added.
    const stmt = this.#db.prepare(`
      INSERT OR REPLACE INTO request_logs (
        id, api_key_id, api_key_name, started_at, method, url, upstream_url, path,
        model, is_stream, request_headers, request_body, request_body_truncated,
        status, response_headers, response_body, response_body_truncated,
        duration_ms, ttft_ms, chunk_count, prompt_tokens, completion_tokens,
        terminal_state, finish_reason, error
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`);
    this.#db.exec('BEGIN');
    try {
      for (const r of records) {
        stmt.run(
          r.id,
          r.apiKeyId,
          r.apiKeyName,
          r.startedAt,
          r.method,
          r.url,
          r.upstreamUrl,
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
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err; // the ingest handler turns this into a 500, and the sink retries
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
    // An explicit span beats the relative window — see the note on Filters.
    if (filters.from !== undefined || filters.to !== undefined) {
      if (filters.from !== undefined) {
        where.push('started_at >= ?');
        params.push(filters.from);
      }
      if (filters.to !== undefined) {
        where.push('started_at <= ?');
        params.push(filters.to);
      }
    } else if (filters.windowMs) {
      // Resolved here, not on the client, so the window stays relative to now
      // on every query. Rides the (api_key_id, started_at DESC) index.
      where.push('started_at >= ?');
      params.push(Date.now() - filters.windowMs);
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

  /**
   * The same numbers the KPI strip shows, but bucketed over time.
   *
   * Bucketing happens in SQL — `started_at / bucketMs` floors each row into a
   * slot and GROUP BY does the rest — so this is one indexed scan rather than
   * pulling every row into JS to sort them into piles.
   *
   * Empty buckets are filled in afterwards. Leaving them out would make a chart
   * draw a straight line across an outage, which is the exact moment you most
   * need to see a gap.
   */
  series(apiKeyId: string, from: number, to: number): Series {
    const span = Math.max(1, to - from);
    // Round to a whole number of ms per bucket; the last bucket may be partial.
    const bucketMs = Math.max(1000, Math.ceil(span / SERIES_BUCKETS));

    const rows = this.#db
      .prepare(
        `SELECT CAST(started_at / ? AS INTEGER) AS slot,
                COUNT(*) AS requests,
                SUM(CASE WHEN terminal_state != 'completed' THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens
         FROM request_logs
         WHERE api_key_id = ? AND started_at >= ? AND started_at <= ?
         GROUP BY slot ORDER BY slot`,
      )
      .all(bucketMs, apiKeyId, from, to) as any[];

    // p50 per bucket needs the durations themselves, not an aggregate — SQLite
    // has no percentile function. Capped, because a chart is not worth an
    // unbounded read.
    const durations = new Map<number, number[]>();
    for (const r of this.#db
      .prepare(
        `SELECT CAST(started_at / ? AS INTEGER) AS slot, duration_ms
         FROM request_logs
         WHERE api_key_id = ? AND started_at >= ? AND started_at <= ?
         ORDER BY slot LIMIT 20000`,
      )
      .all(bucketMs, apiKeyId, from, to) as any[]) {
      const slot = Number(r.slot);
      const list = durations.get(slot) ?? [];
      list.push(Number(r.duration_ms));
      durations.set(slot, list);
    }

    const bySlot = new Map<number, any>(rows.map((r) => [Number(r.slot), r]));
    const firstSlot = Math.floor(from / bucketMs);
    const lastSlot = Math.floor(to / bucketMs);

    const buckets: Bucket[] = [];
    for (let slot = firstSlot; slot <= lastSlot; slot++) {
      const r = bySlot.get(slot);
      const d = durations.get(slot);
      if (d) d.sort((a, b) => a - b);
      buckets.push({
        t: slot * bucketMs,
        requests: r ? Number(r.requests) : 0,
        errors: r ? Number(r.errors ?? 0) : 0,
        p50: d && d.length > 0 ? d[Math.floor(d.length / 2)]! : null,
        promptTokens: r ? Number(r.prompt_tokens ?? 0) : 0,
        completionTokens: r ? Number(r.completion_tokens ?? 0) : 0,
      });
    }

    return { buckets, bucketMs, from, to };
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
    upstreamUrl: row.upstream_url ?? null,
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
  // A live row is by definition recent, so these rarely reject anything — but
  // the two predicates have to stay identical or a filtered view shows rows on
  // arrival that disappear on refresh.
  //
  // The `to` bound is the one that earns its keep: viewing a span that ended in
  // the past, live rows must NOT appear, and without this they would.
  if (filters.from !== undefined || filters.to !== undefined) {
    if (filters.from !== undefined && row.startedAt < filters.from) return false;
    if (filters.to !== undefined && row.startedAt > filters.to) return false;
  } else if (filters.windowMs && row.startedAt < Date.now() - filters.windowMs) {
    return false;
  }
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
