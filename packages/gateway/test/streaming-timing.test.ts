import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { postChat, readEvents, startStack, waitForLog } from './helpers.ts';

/**
 * The headline tests: is the caller's stream delayed by anything the gateway does?
 *
 * Every mock chunk carries `emittedAt`, so `arrivedAt - emittedAt` is the
 * gateway's transit cost for that chunk. Two shapes are possible:
 *
 *   streaming  -> overhead is small and FLAT across all chunks
 *   buffering  -> overhead for chunk 0 is the whole generation time, and
 *                 falls away linearly to ~0 for the last chunk
 *
 * So a flat line is the proof. Nothing else produces one.
 */

let stack: Awaited<ReturnType<typeof startStack>>;

beforeEach(async () => {
  stack = await startStack();
});
afterEach(async () => {
  await stack.close();
});

describe('streaming is not delayed by the gateway', () => {
  it('adds a small, flat overhead to every chunk', async () => {
    const CHUNKS = 12;
    const GAP_MS = 40;

    const res = await postChat(stack.gatewayUrl, {
      mock: { chunks: CHUNKS, 'gap-ms': GAP_MS },
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const overheads: number[] = [];
    for await (const evt of readEvents(res)) {
      if (typeof evt.json?.emittedAt === 'number') {
        overheads.push(evt.arrivedAt - evt.json.emittedAt);
      }
    }

    expect(overheads).toHaveLength(CHUNKS);

    const spread = Math.max(...overheads) - Math.min(...overheads);
    const bufferedWouldBe = (CHUNKS - 1) * GAP_MS; // 440ms

    expect(overheads[0]).toBeLessThan(100);
    expect(spread).toBeLessThan(100);
    expect(spread).toBeLessThan(bufferedWouldBe / 3); // nowhere near the buffering shape
  });

  it('delivers the first chunk immediately even when the rest is slow', async () => {
    // One chunk now, the next a second later. A proxy that buffers the body
    // cannot deliver anything before the whole second has passed.
    const started = Date.now();
    const res = await postChat(stack.gatewayUrl, { mock: { chunks: 2, 'gap-ms': 1000 } });

    let firstAt = 0;
    let lastAt = 0;
    for await (const evt of readEvents(res)) {
      if (typeof evt.json?.emittedAt !== 'number') continue;
      if (firstAt === 0) firstAt = evt.arrivedAt;
      lastAt = evt.arrivedAt;
    }

    expect(firstAt - started).toBeLessThan(300);
    expect(lastAt - started).toBeGreaterThan(900);
  });

  it('reassembles the same text the caller received', async () => {
    const res = await postChat(stack.gatewayUrl, { mock: { chunks: 6, 'gap-ms': 5 } });
    const id = res.headers.get('x-gateway-request-id')!;

    let clientText = '';
    for await (const evt of readEvents(res)) {
      const piece = evt.json?.choices?.[0]?.delta?.content;
      if (typeof piece === 'string') clientText += piece;
    }

    const record = await waitForLog(stack.sink, id);
    expect(record.responseBody).toBe(clientText);
    expect(record.chunkCount).toBe(6);
    expect(record.ttftMs).not.toBeNull();
    expect(record.ttftMs!).toBeLessThan(record.durationMs + 1);
  });
});
