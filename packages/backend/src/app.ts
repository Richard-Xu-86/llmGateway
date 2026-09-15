import { Hono } from 'hono';
import { IngestBatch } from '@gw/shared';
import { authenticate, type ApiKey } from '@gw/shared/keys';
import type { Filters, LogStore } from './db.ts';
import type { Hub } from './ws.ts';

export interface BackendConfig {
  store: LogStore;
  hub: Hub;
  keys: ApiKey[];
  ingestSecret: string;
}

const list = (value: string | undefined): string[] | undefined =>
  value ? value.split(',').map((v) => v.trim()).filter(Boolean) : undefined;

/**
 * A look-back window, clamped. An unbounded one is an unbounded table scan that
 * any caller could ask for, so 30 days is the ceiling regardless of what
 * arrives. Returns undefined for anything unusable, which means "no limit
 * beyond the page size".
 */
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const window = (value: string | undefined): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_WINDOW_MS) : undefined;
};

/** An absolute instant from the query string, or undefined if it is not one. */
const instant = (value: string | undefined): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
};

/**
 * Reads an explicit span, and only returns one if it is actually usable.
 *
 * A reversed span (`from` after `to`) is a slider dragged past itself or a
 * fat-fingered date. Returning it would produce an empty table with nothing to
 * explain why, so the two are swapped instead — the user's intent is
 * unambiguous even when their input is backwards.
 */
const span = (q: Record<string, string>): { from?: number; to?: number } => {
  let from = instant(q.from);
  let to = instant(q.to);
  if (from !== undefined && to !== undefined && from > to) [from, to] = [to, from];
  return { from, to };
};

/** How far back an explicit span may reach, matching the relative-window ceiling. */
const clampSpan = (from: number | undefined, to: number | undefined) => {
  const now = Date.now();
  const floor = now - MAX_WINDOW_MS;
  return {
    from: Math.max(from ?? now - 60 * 60 * 1000, floor),
    to: Math.min(to ?? now, now),
  };
};

export function createBackend({ store, hub, keys, ingestSecret }: BackendConfig) {
  const app = new Hono();

  /**
   * Records the gateway dropped under back-pressure, as last reported.
   *
   * The counter lives in the gateway process, so it has to travel; it rides the
   * ingest batch rather than getting a channel of its own. Held in memory
   * because it describes this run of the gateway, not the history of the data.
   */
  let droppedRecords = 0;

  app.get('/healthz', (c) => c.json({ ok: true, subscribers: hub.size, droppedRecords }));

  /**
   * Internal. The gateway ships batches here off its response path.
   * Shared-secret rather than a gateway key: this is service-to-service, and it
   * must not be possible to write logs by holding a *caller's* key.
   */
  app.post('/ingest', async (c) => {
    if (c.req.header('x-ingest-secret') !== ingestSecret) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const parsed = IngestBatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'malformed batch' }, 400);

    store.insert(parsed.data.records);
    for (const record of parsed.data.records) hub.broadcast(record);

    // Monotonic on the gateway's side; max() rather than assignment so a batch
    // arriving out of order cannot walk the number backwards.
    if (typeof parsed.data.droppedTotal === 'number') {
      droppedRecords = Math.max(droppedRecords, parsed.data.droppedTotal);
    }

    return c.json({ accepted: parsed.data.records.length });
  });

  /**
   * Everything below is scoped to the key that was presented.
   *
   * Note what is missing: no endpoint accepts an api_key_id parameter. The only
   * way to say which logs you want is to prove which key you hold, so there is
   * no version of these handlers that can be talked into crossing tenants.
   */
  app.use('/api/*', async (c, next) => {
    const key = authenticate(keys, c.req.header('authorization'));
    if (!key) return c.json({ error: 'invalid gateway API key' }, 401);
    c.set('key' as never, key as never);
    await next();
  });

  const keyOf = (c: any): ApiKey => c.get('key');

  app.get('/api/me', (c) => {
    const key = keyOf(c);
    return c.json({ name: key.name, last4: key.last4 });
  });

  app.get('/api/logs', (c) => {
    const q = c.req.query();
    const filters: Filters = {
      methods: list(q.methods),
      statusClasses: list(q.status),
      terminalStates: list(q.states),
      models: list(q.models),
      q: q.q || undefined,
      windowMs: window(q.windowMs),
      ...span(q),
    };
    const limit = Math.min(Number(q.limit) || 50, 200);
    return c.json(store.query(keyOf(c).id, filters, q.cursor ?? null, limit));
  });

  app.get('/api/logs/:id', (c) => {
    const record = store.get(keyOf(c).id, c.req.param('id'));
    return record ? c.json(record) : c.json({ error: 'not found' }, 404);
  });

  /**
   * Current window and the one before it, so the dashboard can show a delta.
   * "p95 is 2.2s" is a number; "p95 is 2.2s, down 340ms" is information.
   */
  app.get('/api/stats', (c) => {
    const q = c.req.query();
    const explicit = span(q);
    const now = Date.now();

    // An explicit span governs here exactly as it does for /api/logs and
    // /api/series. It has to: the tiles, the charts and the table sit on one
    // screen, and three endpoints disagreeing about the window shows up as
    // "0 requests" above a chart that is plainly drawing traffic.
    const range =
      explicit.from !== undefined || explicit.to !== undefined
        ? clampSpan(explicit.from, explicit.to)
        : (() => {
            const w = window(q.windowMs) ?? 60 * 60 * 1000;
            return { from: now - w, to: now };
          })();

    // The comparison is always the equally-sized period immediately before,
    // whether that period was chosen relatively or by hand.
    const width = Math.max(1, range.to - range.from);

    return c.json({
      current: store.stats(keyOf(c).id, range.from, range.to),
      previous: store.stats(keyOf(c).id, range.from - width, range.from),
      droppedRecords,
    });
  });

  app.get('/api/models', (c) => c.json({ models: store.models(keyOf(c).id) }));

  /**
   * The same numbers as /api/stats, bucketed over time.
   *
   * Two totals tell you the error rate doubled. They cannot tell you whether it
   * doubled gradually all week or stepped up at 14:20 on Tuesday, which is the
   * question during an incident — so the chart gets its own endpoint rather
   * than the dashboard trying to infer shape from the rows it happens to hold.
   */
  app.get('/api/series', (c) => {
    const q = c.req.query();
    const explicit = span(q);
    const now = Date.now();
    const windowMs = window(q.windowMs) ?? 60 * 60 * 1000;
    const range =
      explicit.from !== undefined || explicit.to !== undefined
        ? clampSpan(explicit.from, explicit.to)
        : { from: now - windowMs, to: now };
    return c.json(store.series(keyOf(c).id, range.from, range.to));
  });

  return app;
}
