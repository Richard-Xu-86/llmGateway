import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogRecord } from '@gw/shared';
import { parseKeySpec } from '@gw/shared/keys';
import { createBackend } from '../src/app.ts';
import { LogStore, matchesFilters, summarise } from '../src/db.ts';
import { Hub } from '../src/ws.ts';

/**
 * Two additions, tested together because they share a bound.
 *
 * `windowMs` answers "the recent past" and slides; `from`/`to` answers "this
 * fixed period" and must not. They cannot both govern a query, so the rule is
 * that an explicit span wins — and the same rule has to hold in SQL, in the
 * live WebSocket predicate, and in the chart, or a filtered view disagrees with
 * itself depending on which one you look at.
 */

const KEYS = 'app:gw_live_range_test_key';
const KEY = 'gw_live_range_test_key';
const MIN = 60_000;

let store: LogStore;
let app: ReturnType<typeof createBackend>;
let now: number;

const record = (over: Partial<LogRecord> = {}): LogRecord =>
  ({
    id: crypto.randomUUID(),
    apiKeyId: parseKeySpec(KEYS)[0]!.id,
    apiKeyName: 'app',
    startedAt: now,
    method: 'POST',
    url: 'http://localhost:4000/v1/chat/completions',
    upstreamUrl: 'https://api.openai.com/v1/chat/completions',
    path: '/v1/chat/completions',
    model: 'gpt-4o-mini',
    isStream: true,
    requestHeaders: {},
    requestBody: null,
    requestBodyTruncated: false,
    status: 200,
    responseHeaders: {},
    responseBody: 'hi',
    responseBodyTruncated: false,
    durationMs: 100,
    ttftMs: 40,
    chunkCount: 3,
    promptTokens: 10,
    completionTokens: 20,
    terminalState: 'completed',
    finishReason: 'stop',
    error: null,
    ...over,
  }) as LogRecord;

const get = (path: string) =>
  app.request(`http://localhost${path}`, { headers: { authorization: `Bearer ${KEY}` } });

beforeEach(() => {
  now = Date.now();
  store = new LogStore(':memory:');
  app = createBackend({ store, hub: new Hub(), keys: parseKeySpec(KEYS), ingestSecret: 's' });
});
afterEach(() => store.close());

describe('an explicit span', () => {
  beforeEach(() => {
    // One request every 10 minutes for the last two hours.
    store.insert(
      Array.from({ length: 12 }, (_, i) => record({ startedAt: now - i * 10 * MIN })),
    );
  });

  it('returns only what falls inside it', async () => {
    const from = now - 45 * MIN;
    const to = now - 15 * MIN;
    const body = (await (await get(`/api/logs?from=${from}&to=${to}`)).json()) as any;

    expect(body.rows.length).toBe(3); // 20, 30 and 40 minutes ago
    for (const r of body.rows) {
      expect(r.startedAt).toBeGreaterThanOrEqual(from);
      expect(r.startedAt).toBeLessThanOrEqual(to);
    }
  });

  it('beats windowMs rather than intersecting with it', async () => {
    // A 15-minute window and a span two hours back. Intersecting would give
    // nothing, with no way for the user to tell why.
    const from = now - 120 * MIN;
    const to = now - 60 * MIN;
    const body = (await (
      await get(`/api/logs?windowMs=${15 * MIN}&from=${from}&to=${to}`)
    ).json()) as any;

    expect(body.rows.length).toBeGreaterThan(0);
    expect(Math.max(...body.rows.map((r: any) => r.startedAt))).toBeLessThanOrEqual(to);
  });

  it('is unbounded on the side you leave out', async () => {
    const onlyFrom = (await (await get(`/api/logs?from=${now - 25 * MIN}`)).json()) as any;
    expect(onlyFrom.rows.length).toBe(3);

    const onlyTo = (await (await get(`/api/logs?to=${now - 95 * MIN}`)).json()) as any;
    expect(onlyTo.rows.length).toBe(2);
  });

  it('swaps a reversed span instead of returning nothing', async () => {
    // A slider dragged past itself, or a mistyped date. An empty table with no
    // explanation is the worst available answer; the intent is unambiguous.
    const a = (await (await get(`/api/logs?from=${now - 45 * MIN}&to=${now - 15 * MIN}`)).json()) as any;
    const b = (await (await get(`/api/logs?from=${now - 15 * MIN}&to=${now - 45 * MIN}`)).json()) as any;
    expect(b.rows.length).toBe(a.rows.length);
  });

  it('ignores junk rather than failing the request', async () => {
    for (const q of ['from=yesterday', 'to=NaN', 'from=-5', 'from=&to=']) {
      const res = await get(`/api/logs?${q}`);
      expect(res.status).toBe(200);
    }
  });
});

describe('the live predicate agrees with the SQL', () => {
  const summary = (startedAt: number) => summarise(record({ startedAt }));

  it('accepts a row inside the span', () => {
    expect(matchesFilters(summary(now - 30 * MIN), { from: now - 45 * MIN, to: now - 15 * MIN })).toBe(
      true,
    );
  });

  it('rejects a row after `to` — the case that matters', () => {
    // Viewing a span that ended in the past, live rows must not appear. Without
    // the `to` check they would stream in and then vanish on refresh.
    expect(matchesFilters(summary(now), { from: now - 60 * MIN, to: now - 30 * MIN })).toBe(false);
  });

  it('rejects a row before `from`', () => {
    expect(matchesFilters(summary(now - 90 * MIN), { from: now - 60 * MIN })).toBe(false);
  });

  it('lets the span override windowMs, exactly as the query does', () => {
    const old = summary(now - 90 * MIN);
    expect(matchesFilters(old, { windowMs: 15 * MIN })).toBe(false);
    expect(matchesFilters(old, { windowMs: 15 * MIN, from: now - 120 * MIN, to: now })).toBe(true);
  });
});

describe('the time series', () => {
  it('buckets requests across the span', async () => {
    store.insert(
      Array.from({ length: 30 }, (_, i) => record({ startedAt: now - i * MIN })),
    );
    const body = (await (await get(`/api/series?windowMs=${30 * MIN}`)).json()) as any;

    expect(body.bucketMs).toBeGreaterThan(0);
    expect(body.buckets.length).toBeGreaterThan(1);
    expect(body.buckets.reduce((a: number, b: any) => a + b.requests, 0)).toBeGreaterThan(0);
  });

  it('emits empty buckets rather than skipping them', async () => {
    // A gap in traffic must draw as a gap. Omitting the quiet buckets would let
    // a chart interpolate a straight line across an outage.
    store.insert([
      record({ startedAt: now - 60 * MIN }),
      record({ startedAt: now - 1 * MIN }),
    ]);
    const body = (await (await get(`/api/series?windowMs=${60 * MIN}`)).json()) as any;
    expect(body.buckets.some((b: any) => b.requests === 0)).toBe(true);
  });

  it('reports p50 as null for an empty bucket, not zero', async () => {
    store.insert([record({ startedAt: now - 1 * MIN })]);
    const body = (await (await get(`/api/series?windowMs=${60 * MIN}`)).json()) as any;
    const empty = body.buckets.find((b: any) => b.requests === 0);
    // Zero would plot as "instant", which is a lie about a period with no data.
    expect(empty.p50).toBeNull();
  });

  it('counts a 200 that died mid-stream as an error', async () => {
    store.insert([
      record({ startedAt: now - 1 * MIN, status: 200, terminalState: 'truncated' }),
      record({ startedAt: now - 1 * MIN, status: 200, terminalState: 'completed' }),
    ]);
    const body = (await (await get(`/api/series?windowMs=${10 * MIN}`)).json()) as any;
    const errors = body.buckets.reduce((a: number, b: any) => a + b.errors, 0);
    expect(errors).toBe(1);
  });

  it('honours an explicit span', async () => {
    store.insert([
      record({ startedAt: now - 90 * MIN }),
      record({ startedAt: now - 1 * MIN }),
    ]);
    const body = (await (
      await get(`/api/series?from=${now - 120 * MIN}&to=${now - 60 * MIN}`)
    ).json()) as any;
    expect(body.buckets.reduce((a: number, b: any) => a + b.requests, 0)).toBe(1);
  });

  it('stays scoped to the presented key', async () => {
    store.insert([record({ startedAt: now - MIN, apiKeyId: 'someone-else' })]);
    const body = (await (await get(`/api/series?windowMs=${10 * MIN}`)).json()) as any;
    expect(body.buckets.reduce((a: number, b: any) => a + b.requests, 0)).toBe(0);
  });
});

describe('every endpoint agrees about the window', () => {
  /**
   * The bug this pins: /api/logs and /api/series honoured an explicit span
   * while /api/stats quietly fell back to "the last hour". On one screen that
   * read as "0 requests" in the tiles above a chart plainly drawing traffic —
   * the worst kind of wrong, because nothing looked broken.
   */
  it('stats matches the series over the same explicit span', async () => {
    store.insert([
      record({ startedAt: now - 90 * MIN }),
      record({ startedAt: now - 80 * MIN }),
      record({ startedAt: now - 1 * MIN }), // outside the span
    ]);
    const from = now - 120 * MIN;
    const to = now - 60 * MIN;

    const stats = (await (await get(`/api/stats?from=${from}&to=${to}`)).json()) as any;
    const series = (await (await get(`/api/series?from=${from}&to=${to}`)).json()) as any;
    const logs = (await (await get(`/api/logs?from=${from}&to=${to}`)).json()) as any;

    const charted = series.buckets.reduce((a: number, b: any) => a + b.requests, 0);
    expect(stats.current.total).toBe(2);
    expect(charted).toBe(2);
    expect(logs.rows.length).toBe(2);
  });

  it('compares against the period immediately before the span', async () => {
    store.insert([
      record({ startedAt: now - 30 * MIN }), // inside
      record({ startedAt: now - 90 * MIN }), // the hour before
      record({ startedAt: now - 95 * MIN }),
    ]);
    const stats = (await (
      await get(`/api/stats?from=${now - 60 * MIN}&to=${now}`)
    ).json()) as any;

    expect(stats.current.total).toBe(1);
    expect(stats.previous.total).toBe(2);
  });

  it('still uses the relative window when no span is given', async () => {
    store.insert([record({ startedAt: now - 5 * MIN }), record({ startedAt: now - 300 * MIN })]);
    const stats = (await (await get(`/api/stats?windowMs=${60 * MIN}`)).json()) as any;
    expect(stats.current.total).toBe(1);
  });
});
