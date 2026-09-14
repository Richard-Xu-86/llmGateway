import { Hono } from 'hono';

/**
 * A stand-in for api.openai.com that behaves like a metronome.
 *
 * Two reasons it exists:
 *  1. `npm run dev` works with no OpenAI key and costs nothing.
 *  2. Every chunk carries the timestamp it was emitted at, which turns
 *     "is the proxy adding latency?" into an arithmetic question instead of
 *     a judgement call. See packages/gateway/test/streaming-timing.test.ts.
 *
 * Behaviour is driven by request headers so a test can ask for exactly the
 * pathological stream it needs:
 *   x-mock-chunks          how many content chunks        (default 8)
 *   x-mock-gap-ms          delay between chunks           (default 40)
 *   x-mock-first-delay-ms  delay before the first chunk   (default 0)
 *   x-mock-fail-after      emit an in-band error after N chunks
 *   x-mock-status          reply with this status and no stream
 *   x-mock-split-at        cut every frame after N bytes, send the halves apart
 *   x-mock-request-id      tag this request so a test can read its stats back
 */

export interface MockStats {
  emitted: number;
  aborted: boolean;
  errored: boolean;
  completed: boolean;
}

export const stats = new Map<string, MockStats>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function contentChunk(i: number, model: string) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    // Not part of OpenAI's schema — the mock adds it so tests can measure
    // per-chunk transit time through the gateway.
    emittedAt: Date.now(),
    chunkIndex: i,
    choices: [{ index: 0, delta: { content: `tok${i} ` }, finish_reason: null }],
  };
}

export const app = new Hono();

app.get('/__mock/stats/:id', (c) => {
  const s = stats.get(c.req.param('id'));
  return s ? c.json(s) : c.json({ error: 'unknown request id' }, 404);
});

app.post('/v1/chat/completions', async (c) => {
  const h = c.req.header.bind(c.req);
  const forcedStatus = h('x-mock-status');
  if (forcedStatus) {
    return c.json(
      { error: { message: 'mock upstream rejected the request', type: 'invalid_request_error' } },
      Number(forcedStatus) as 400,
    );
  }

  const body = await c.req.json<Record<string, any>>().catch(() => ({}) as Record<string, any>);
  const model = typeof body.model === 'string' ? body.model : 'gpt-4o-mini';
  let wantsUsage = body?.stream_options?.include_usage === true;

  const chunks = num(h('x-mock-chunks'), 8);
  const gapMs = num(h('x-mock-gap-ms'), 40);
  const firstDelayMs = num(h('x-mock-first-delay-ms'), 0);
  const failAfterRaw = h('x-mock-fail-after');
  const failAfter = failAfterRaw === undefined ? null : Number(failAfterRaw);

  const statsId = h('x-mock-request-id') ?? crypto.randomUUID();
  const s: MockStats = { emitted: 0, aborted: false, errored: false, completed: false };
  stats.set(statsId, s);

  if (body.stream !== true) {
    await sleep(firstDelayMs + gapMs * chunks);
    s.emitted = chunks;
    s.completed = true;
    return c.json({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: expectedText(chunks) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: chunks, total_tokens: 11 + chunks },
    });
  }

  const signal = c.req.raw.signal;
  let i = 0;
  let closed = false;

  /**
   * x-mock-split-at N cuts every frame after N bytes and sends the halves in
   * two writes, which is what a real upstream does to you all the time: TCP has
   * no idea what an SSE event is. A well-behaved proxy must cope with a read
   * that contains no complete event at all.
   *
   * Worth a mock feature of its own, because without it every frame arrives
   * whole and a proxy that mishandles partials looks perfect right up until it
   * meets api.openai.com.
   */
  const splitAt = num(h('x-mock-split-at'), 0);
  let pendingTail: Uint8Array | null = null;
  let closeAfterTail = false;

  // pull-driven on purpose: if the consumer stops reading, `pull` stops being
  // called and `s.emitted` stops climbing. That is how the back-pressure test
  // observes that back-pressure actually reaches the upstream.
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      if (signal?.aborted) {
        s.aborted = true;
        closed = true;
        controller.close();
        return;
      }

      // Second half of a split frame. The gap is what makes it a separate TCP
      // segment rather than a coalesced write.
      if (pendingTail !== null) {
        await sleep(Math.max(gapMs, 5));
        const tail = pendingTail;
        pendingTail = null;
        controller.enqueue(tail);
        if (closeAfterTail) {
          s.completed = true;
          closed = true;
          controller.close();
        }
        return;
      }

      /** Enqueue a whole frame, or its first half if splitting is on. */
      const frame = (text: string, closeAfter = false) => {
        const bytes = enc.encode(text);
        if (splitAt > 0 && bytes.byteLength > splitAt) {
          controller.enqueue(bytes.subarray(0, splitAt));
          pendingTail = bytes.subarray(splitAt);
          closeAfterTail = closeAfter;
          return false; // not finished with this frame yet
        }
        controller.enqueue(bytes);
        return true;
      };

      if (i === 0 && firstDelayMs > 0) await sleep(firstDelayMs);
      else if (i > 0) await sleep(gapMs);

      if (signal?.aborted) {
        s.aborted = true;
        closed = true;
        controller.close();
        return;
      }

      if (failAfter !== null && i >= failAfter) {
        frame(
          `data: ${JSON.stringify({
            error: { message: 'mock upstream exploded mid-stream', type: 'server_error' },
          })}\n\n`,
          true,
        );
        s.errored = true;
        if (pendingTail === null) {
          closed = true;
          controller.close();
        }
        return;
      }

      if (i < chunks) {
        frame(`data: ${JSON.stringify(contentChunk(i, model))}\n\n`);
        s.emitted++;
        i++;
        return;
      }

      if (wantsUsage) {
        wantsUsage = false;
        frame(
          `data: ${JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            model,
            choices: [],
            usage: {
              prompt_tokens: 11,
              completion_tokens: chunks,
              total_tokens: 11 + chunks,
            },
          })}\n\n`,
        );
        // Splitting the usage frame means the caller-visible stream gets a read
        // that yields nothing at all once the gateway strips it — the exact
        // shape that used to deadlock. The tail goes out on the next pull.
        return;
      }

      if (!frame('data: [DONE]\n\n', true)) return;
      s.completed = true;
      closed = true;
      controller.close();
    },
    cancel() {
      closed = true;
      s.aborted = true;
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      // No `connection` header here either — same hop-by-hop reason as the
      // gateway. The mock should behave like a well-mannered upstream.
    },
  });
});

/** What the reassembled assistant message should be for N chunks. */
export function expectedText(chunks: number): string {
  return Array.from({ length: chunks }, (_, i) => `tok${i} `).join('');
}
