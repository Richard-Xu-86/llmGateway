import { describe, expect, it, vi } from 'vitest';
import type { LogRecord } from '@gw/shared';
import { ClientMessage } from '@gw/shared';
import { Hub } from '../src/ws.ts';

/**
 * A subscriber must not be able to stop ingestion.
 *
 * `Hub.broadcast` runs inside the ingest handler, so anything it throws becomes
 * a 500 — and the gateway's sink answers a 500 by putting the batch back and
 * retrying every 250ms. For ever. One malformed frame from one authenticated
 * dashboard therefore stalled log ingestion for *every* tenant, which is the
 * only cross-tenant failure this system had.
 *
 * The hole was that filters were stored exactly as received. The predicate
 * calls `.includes()` on them, so a value merely *shaped* like an array
 * — `{ length: 1 }` — passed the `?.length` truthiness check and then threw.
 *
 * Two independent defences now, and both are tested: the message is parsed
 * before it is stored, and fan-out degrades one connection at a time even if
 * something invalid gets through anyway.
 */

const socket = () => ({
  readyState: 1,
  OPEN: 1,
  send: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
});

const record = (over: Partial<LogRecord> = {}): LogRecord =>
  ({
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
  }) as LogRecord;

describe('the filter message is parsed, not trusted', () => {
  it('rejects a value that is only shaped like an array', () => {
    // The exact payload that used to stall ingestion.
    const parsed = ClientMessage.safeParse({
      type: 'filters',
      filters: { methods: { length: 1 } },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects the other near-misses too', () => {
    for (const methods of ['POST', 5, {}, [1, 2], null]) {
      expect(ClientMessage.safeParse({ type: 'filters', filters: { methods } }).success).toBe(false);
    }
  });

  it('rejects a message that is not a filters message at all', () => {
    expect(ClientMessage.safeParse({ type: 'log', row: {} }).success).toBe(false);
    expect(ClientMessage.safeParse('hello').success).toBe(false);
    expect(ClientMessage.safeParse(null).success).toBe(false);
  });

  it('accepts what the dashboard actually sends', () => {
    const parsed = ClientMessage.safeParse({
      type: 'filters',
      filters: { methods: ['POST'], statusClasses: ['4xx'], q: 'chat', windowMs: 3_600_000 },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.filters?.methods).toEqual(['POST']);
  });

  it('accepts an empty filter set — "show me everything"', () => {
    expect(ClientMessage.safeParse({ type: 'filters' }).success).toBe(true);
    expect(ClientMessage.safeParse({ type: 'filters', filters: {} }).success).toBe(true);
  });

  it('caps list lengths, so one frame cannot become a huge predicate', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `m${i}`);
    expect(ClientMessage.safeParse({ type: 'filters', filters: { methods: tooMany } }).success).toBe(
      false,
    );
  });
});

describe('fan-out degrades one connection at a time', () => {
  it('a broken subscriber does not stop delivery to the others', () => {
    const hub = new Hub();
    const good = socket();
    const alsoGood = socket();
    const broken = socket();

    hub.add({ socket: good as never, apiKeyId: 'key-1', filters: {} });
    // Bypassing validation on purpose: this asserts the *second* defence, so
    // that a future code path which forgets to parse cannot take ingestion down.
    hub.add({ socket: broken as never, apiKeyId: 'key-1', filters: { methods: { length: 1 } } as never });
    hub.add({ socket: alsoGood as never, apiKeyId: 'key-1', filters: {} });

    expect(() => hub.broadcast(record())).not.toThrow();

    expect(good.send).toHaveBeenCalledTimes(1);
    expect(alsoGood.send).toHaveBeenCalledTimes(1);
    expect(broken.send).not.toHaveBeenCalled();
  });

  it('evicts the broken subscriber rather than failing on it again', () => {
    const hub = new Hub();
    const broken = socket();
    hub.add({ socket: broken as never, apiKeyId: 'key-1', filters: { methods: { length: 1 } } as never });
    expect(hub.size).toBe(1);

    hub.broadcast(record());

    expect(hub.size).toBe(0);
    expect(broken.close).toHaveBeenCalled();
  });

  it('still honours the tenancy boundary while doing it', () => {
    const hub = new Hub();
    const other = socket();
    hub.add({ socket: other as never, apiKeyId: 'key-2', filters: {} });

    hub.broadcast(record({ apiKeyId: 'key-1' }));

    expect(other.send).not.toHaveBeenCalled();
  });
});
