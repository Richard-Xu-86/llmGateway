import { describe, expect, it } from 'vitest';
import type { LogRecord } from '@gw/shared';
import type { LogSink } from '../src/sink.ts';
import { postChat, readEvents, startStack } from './helpers.ts';

/**
 * Proves the property directly: logging sits off the caller's path.
 *
 * The sink is an injected interface precisely so a test can replace it with
 * something hostile. If a sink that blocks the event loop for 300ms — or one
 * that throws outright — changes what the caller experiences, the design is
 * wrong, not the sink.
 */

class BlockingSink implements LogSink {
  calls = 0;
  records: LogRecord[] = [];
  constructor(private readonly blockMs: number) {}
  write(record: LogRecord): void {
    this.calls++;
    this.records.push(record);
    const until = Date.now() + this.blockMs; // deliberately synchronous
    while (Date.now() < until) {
      /* block the event loop */
    }
  }
}

class ExplodingSink implements LogSink {
  calls = 0;
  write(): void {
    this.calls++;
    throw new Error('sink is down');
  }
}

describe('log shipping is isolated from the response path', () => {
  it('a sink that blocks for 300ms does not move per-chunk timings', async () => {
    const sink = new BlockingSink(300);
    const stack = await startStack({ sink });
    try {
      const res = await postChat(stack.gatewayUrl, { mock: { chunks: 10, 'gap-ms': 30 } });

      const overheads: number[] = [];
      for await (const evt of readEvents(res)) {
        if (typeof evt.json?.emittedAt === 'number') {
          overheads.push(evt.arrivedAt - evt.json.emittedAt);
        }
      }

      expect(Math.max(...overheads)).toBeLessThan(100);

      // The guard that matters: one write per request, after the stream ends.
      // If someone later "improves" this to log per chunk, every overhead above
      // would jump by 300ms and this assertion is what catches it.
      expect(sink.calls).toBe(1);
    } finally {
      await stack.close();
    }
  });

  it('a sink that throws does not break the caller', async () => {
    const sink = new ExplodingSink();
    const stack = await startStack({ sink });
    try {
      const res = await postChat(stack.gatewayUrl, { mock: { chunks: 5, 'gap-ms': 5 } });

      let text = '';
      let sawDone = false;
      for await (const evt of readEvents(res)) {
        if (evt.data === '[DONE]') sawDone = true;
        const piece = evt.json?.choices?.[0]?.delta?.content;
        if (typeof piece === 'string') text += piece;
      }

      expect(res.status).toBe(200);
      expect(sawDone).toBe(true);
      expect(text).toBe('tok0 tok1 tok2 tok3 tok4 ');
      expect(sink.calls).toBe(1);
    } finally {
      await stack.close();
    }
  });
});
