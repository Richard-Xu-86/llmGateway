import { beforeEach, describe, expect, it } from 'vitest';
import type { LogRecord } from '@gw/shared';
import { parseKeySpec } from '@gw/shared/keys';
import { createBackend } from '../src/app.ts';
import { LogStore, matchesFilters, summarise } from '../src/db.ts';
import { Hub } from '../src/ws.ts';

const KEY_A = 'gw_test_alpha_0000';
const KEY_B = 'gw_test_beta_1111';
const SECRET = 'test-ingest-secret';

const keys = parseKeySpec(`app-a:${KEY_A},app-b:${KEY_B}`);
const [keyA, keyB] = keys;

function record(over: Partial<LogRecord> = {}): LogRecord {
  return {
    id: crypto.randomUUID(),
    apiKeyId: keyA!.id,
    apiKeyName: 'app-a',
    startedAt: Date.now(),
    method: 'POST',
    url: 'http://localhost:4000/v1/chat/completions',
    upstreamUrl: 'https://api.openai.com/v1/chat/completions',
    path: '/v1/chat/completions',
    model: 'gpt-4o-mini',
    isStream: true,
    requestHeaders: { authorization: '[redacted]' },
    requestBody: '{"model":"gpt-4o-mini"}',
    requestBodyTruncated: false,
    status: 200,
    responseHeaders: { 'content-type': 'text/event-stream' },
    responseBody: 'hello there',
    responseBodyTruncated: false,
    durationMs: 120,
    ttftMs: 30,
    chunkCount: 4,
    promptTokens: 11,
    completionTokens: 4,
    terminalState: 'completed',
    finishReason: 'stop',
    error: null,
    ...over,
  };
}

let app: ReturnType<typeof createBackend>;
let store: LogStore;

beforeEach(() => {
  store = new LogStore(':memory:');
  app = createBackend({ store, hub: new Hub(), keys, ingestSecret: SECRET });
});

const ingest = (records: LogRecord[], secret = SECRET) =>
  app.request('/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-secret': secret },
    body: JSON.stringify({ records }),
  });

const asKey = (key: string, path: string) =>
  app.request(path, { headers: { authorization: `Bearer ${key}` } });

describe('ingest', () => {
  it('refuses a batch without the shared secret', async () => {
    expect((await ingest([record()], 'wrong')).status).toBe(403);
  });

  it('refuses a malformed batch', async () => {
    const res = await app.request('/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-secret': SECRET },
      body: JSON.stringify({ records: [{ id: 'nope' }] }),
    });
    expect(res.status).toBe(400);
  });

  it('carries the gateway\'s dropped count through to the dashboard', async () => {
    // The counter lives in the gateway process, so silent log loss stays silent
    // unless the number travels. It rides the batch.
    await app.request('/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-secret': SECRET },
      body: JSON.stringify({ records: [record()], droppedTotal: 17 }),
    });

    const stats = await (await asKey(KEY_A, '/api/stats')).json();
    expect(stats.droppedRecords).toBe(17);
  });

  it('never walks the dropped count backwards', async () => {
    const send = (droppedTotal: number) =>
      app.request('/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-secret': SECRET },
        body: JSON.stringify({ records: [record()], droppedTotal }),
      });

    await send(40);
    await send(12); // a batch that was queued before the drops happened

    const stats = await (await asKey(KEY_A, '/api/stats')).json();
    expect(stats.droppedRecords).toBe(40);
  });

  it('is idempotent, so a retried batch does not duplicate rows', async () => {
    // The gateway's sink retries on failure, which makes delivery at-least-once.
    const batch = [record(), record()];
    await ingest(batch);
    await ingest(batch);

    const page = await (await asKey(KEY_A, '/api/logs')).json();
    expect(page.rows).toHaveLength(2);
  });
});

describe('tenancy', () => {
  beforeEach(async () => {
    await ingest([
      record({ apiKeyId: keyA!.id, apiKeyName: 'app-a' }),
      record({ apiKeyId: keyB!.id, apiKeyName: 'app-b' }),
    ]);
  });

  it('shows each key only its own logs', async () => {
    const a = await (await asKey(KEY_A, '/api/logs')).json();
    const b = await (await asKey(KEY_B, '/api/logs')).json();

    expect(a.rows).toHaveLength(1);
    expect(b.rows).toHaveLength(1);
    expect(a.rows[0].apiKeyName).toBe('app-a');
    expect(b.rows[0].apiKeyName).toBe('app-b');
  });

  it('will not fetch another key\'s record by id', async () => {
    const b = await (await asKey(KEY_B, '/api/logs')).json();
    const stolen = await asKey(KEY_A, `/api/logs/${b.rows[0].id}`);
    expect(stolen.status).toBe(404); // not 403 — key A cannot even learn it exists
  });

  it('rejects an unknown key', async () => {
    expect((await asKey('gw_live_nope', '/api/logs')).status).toBe(401);
  });

  it('counts stats per key, with the previous window for comparison', async () => {
    const stats = await (await asKey(KEY_A, '/api/stats')).json();
    expect(stats.current.total).toBe(1);
    expect(stats.previous.total).toBe(0);
  });

  it('does not let the previous window leak into the current one', async () => {
    // 90 minutes sits comfortably inside the previous window [now-2h, now-1h);
    // exactly 2h would land on the boundary and flake.
    await ingest([record({ startedAt: Date.now() - 90 * 60 * 1000 })]);
    const stats = await (await asKey(KEY_A, '/api/stats')).json();
    expect(stats.current.total).toBe(1); // the old row is outside the window
    expect(stats.previous.total).toBe(1);
  });
});

describe('filters', () => {
  beforeEach(async () => {
    await ingest([
      record({ method: 'POST', status: 200, terminalState: 'completed', model: 'gpt-4o-mini' }),
      record({ method: 'POST', status: 429, terminalState: 'upstream_error', model: 'gpt-4o' }),
      record({
        method: 'GET',
        status: 200,
        terminalState: 'completed',
        model: null,
        url: 'https://api.openai.com/v1/models',
        path: '/v1/models',
      }),
    ]);
  });

  const rowsFor = async (query: string) =>
    (await (await asKey(KEY_A, `/api/logs${query}`)).json()).rows;

  it('filters by method', async () => {
    expect(await rowsFor('?methods=GET')).toHaveLength(1);
  });

  it('filters by status class', async () => {
    expect(await rowsFor('?status=4xx')).toHaveLength(1);
    expect(await rowsFor('?status=2xx')).toHaveLength(2);
  });

  it('filters by URL substring', async () => {
    expect(await rowsFor('?q=models')).toHaveLength(1);
  });

  it('filters by terminal state, which is how you find broken streams', async () => {
    expect(await rowsFor('?states=upstream_error')).toHaveLength(1);
  });

  it('combines filters', async () => {
    expect(await rowsFor('?methods=POST&status=2xx')).toHaveLength(1);
  });
});

describe('the time window', () => {
  const HOUR = 60 * 60 * 1000;

  beforeEach(async () => {
    await ingest([
      record({ startedAt: Date.now() - 5 * 60 * 1000 }), // 5 minutes ago
      record({ startedAt: Date.now() - 3 * HOUR }), // 3 hours ago
      record({ startedAt: Date.now() - 3 * 24 * HOUR }), // 3 days ago
    ]);
  });

  const rowsFor = async (query: string) =>
    (await (await asKey(KEY_A, `/api/logs${query}`)).json()).rows;

  it('is relative, so it keeps meaning the same thing as time passes', async () => {
    // windowMs rather than an absolute `since`: the client sends a duration and
    // the server resolves it against its own clock on every query.
    expect(await rowsFor(`?windowMs=${HOUR}`)).toHaveLength(1);
    expect(await rowsFor(`?windowMs=${24 * HOUR}`)).toHaveLength(2);
    expect(await rowsFor(`?windowMs=${7 * 24 * HOUR}`)).toHaveLength(3);
  });

  it('returns everything when no window is given', async () => {
    expect(await rowsFor('')).toHaveLength(3);
  });

  it('ignores a nonsense window rather than returning nothing', async () => {
    expect(await rowsFor('?windowMs=banana')).toHaveLength(3);
    expect(await rowsFor('?windowMs=-5')).toHaveLength(3);
  });

  it('clamps an absurd window so a caller cannot ask for a full scan', async () => {
    // A century would be an unbounded scan on a real table.
    const stats = await (await asKey(KEY_A, '/api/stats?windowMs=999999999999999')).json();
    expect(stats.current.total).toBe(3); // 30-day ceiling still covers the fixtures
  });

  it('agrees with the live predicate, so windowed views stay consistent', async () => {
    const fresh = summarise(record({ startedAt: Date.now() - 60_000 }));
    const old = summarise(record({ startedAt: Date.now() - 3 * 24 * HOUR }));

    expect(matchesFilters(fresh, { windowMs: HOUR })).toBe(true);
    expect(matchesFilters(old, { windowMs: HOUR })).toBe(false);
    expect(matchesFilters(old, { windowMs: 7 * 24 * HOUR })).toBe(true);
  });
});

describe('pagination', () => {
  it('walks pages with a keyset cursor', async () => {
    const now = Date.now();
    await ingest(Array.from({ length: 5 }, (_, i) => record({ startedAt: now - i * 1000 })));

    const first = await (await asKey(KEY_A, '/api/logs?limit=2')).json();
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await (
      await asKey(KEY_A, `/api/logs?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)
    ).json();
    expect(second.rows).toHaveLength(2);
    expect(second.rows[0].id).not.toBe(first.rows[0].id);
  });
});

describe('live filter predicate', () => {
  it('agrees with the SQL filters, so live rows do not vanish on refresh', async () => {
    const row = summarise(record({ method: 'POST', status: 429, terminalState: 'upstream_error' }));

    expect(matchesFilters(row, { statusClasses: ['4xx'] })).toBe(true);
    expect(matchesFilters(row, { statusClasses: ['2xx'] })).toBe(false);
    expect(matchesFilters(row, { methods: ['GET'] })).toBe(false);
    expect(matchesFilters(row, { terminalStates: ['upstream_error'] })).toBe(true);
    expect(matchesFilters(row, { q: 'chat' }, 'https://api.openai.com/v1/chat/completions')).toBe(
      true,
    );
    expect(matchesFilters(row, { q: 'embeddings' }, 'https://api.openai.com/v1/chat/completions')).toBe(
      false,
    );
  });
});
