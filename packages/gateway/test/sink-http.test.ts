import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogRecord } from '@gw/shared';
import { HttpSink } from '../src/sink.ts';

/**
 * The queue is bounded, which means under sustained back-pressure it loses
 * records. That is a deliberate choice — the alternative is growing without
 * limit or blocking the proxy — but a logging system that loses data quietly is
 * worse than one that loses data loudly. These tests are about the loudly.
 */

let received: Array<{ records: LogRecord[]; droppedTotal?: number }> = [];
let url: string;
let server: { close: (cb?: () => void) => void };

const SECRET = 'test-ingest-secret';

function record(over: Partial<LogRecord> = {}): LogRecord {
  return {
    id: crypto.randomUUID(),
    apiKeyId: 'key-1',
    apiKeyName: 'app-a',
    startedAt: Date.now(),
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
    durationMs: 10,
    ttftMs: 5,
    chunkCount: 1,
    promptTokens: 1,
    completionTokens: 1,
    terminalState: 'completed',
    finishReason: 'stop',
    error: null,
    ...over,
  };
}

function listen(app: Hono) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({
        url: `http://127.0.0.1:${info.port}/ingest`,
        close: () => new Promise<void>((r) => (s as any).close(() => r())),
      });
    });
  });
}

beforeEach(async () => {
  received = [];
  const app = new Hono();
  app.post('/ingest', async (c) => {
    received.push(await c.req.json());
    return c.json({ ok: true });
  });
  await new Promise<void>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      url = `http://127.0.0.1:${info.port}/ingest`;
      resolve();
    });
    server = s as never;
  });
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('the log sink under back-pressure', () => {
  it('drops the oldest records and counts every one', async () => {
    const sink = new HttpSink({ url, secret: SECRET, maxQueue: 3, intervalMs: 10_000 });
    const records = Array.from({ length: 5 }, () => record());
    for (const r of records) sink.write(r);

    expect(sink.dropped).toBe(2);

    await sink.close();

    const delivered = received.flatMap((b) => b.records.map((r) => r.id));
    // Oldest out first: the two earliest ids are gone, the three newest survive.
    expect(delivered).not.toContain(records[0]!.id);
    expect(delivered).not.toContain(records[1]!.id);
    expect(delivered).toEqual(records.slice(2).map((r) => r.id));
  });

  it('reports the count to the backend, so the loss is visible in the dashboard', async () => {
    const sink = new HttpSink({ url, secret: SECRET, maxQueue: 2, intervalMs: 10_000 });
    for (let i = 0; i < 6; i++) sink.write(record());
    await sink.close();

    expect(received.at(-1)?.droppedTotal).toBe(4);
  });

  it('keeps several batches in flight, because the limit is round-trip time', async () => {
    // Drain rate is batchSize × concurrency / intervalMs. With one batch at a
    // time it was 50 per 250ms — 200 records/sec, and the first ceiling this
    // system hits by a wide margin. Concurrency matters more than batch size
    // here: the bottleneck is latency, not bytes. See docs/scaling.md.
    let peak = 0;
    let open = 0;
    const slow = new Hono();
    slow.post('/ingest', async (c) => {
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((r) => setTimeout(r, 60));
      open -= 1;
      return c.json({ ok: true });
    });

    const { url: slowUrl, close } = await listen(slow);
    const sink = new HttpSink({
      url: slowUrl,
      secret: SECRET,
      batchSize: 2,
      concurrency: 4,
      intervalMs: 10_000,
    });
    for (let i = 0; i < 8; i++) sink.write(record());
    await sink.close();

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4); // and never more than asked for
    await close();
  });

  it('never throws at the caller, whatever the backend does', async () => {
    // Nothing listening on this port; write must still be safe to call from the
    // response path.
    const sink = new HttpSink({ url: 'http://127.0.0.1:1/ingest', secret: SECRET, intervalMs: 10 });
    expect(() => sink.write(record())).not.toThrow();
    await new Promise((r) => setTimeout(r, 40));
    expect(() => sink.write(record())).not.toThrow();
    await sink.close();
  });
});
