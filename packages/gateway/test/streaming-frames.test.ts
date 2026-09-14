import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { expectedText } from '../../mock-openai/src/app.ts';
import { TEST_KEY, postChat, readEvents, startStack, waitForLog } from './helpers.ts';

/**
 * The bug this file exists for, because it cost most of a day.
 *
 * Every other streaming test passed, the SDK tests passed, and the first call
 * to the real OpenAI API hung after one token. No error, no timeout, no log
 * line: the gateway simply stopped reading from upstream and sat there until
 * undici's 300-second body timeout put it out of its misery.
 *
 * The cause was a rule in the Streams spec that is easy to miss. A
 * `ReadableStream`'s `pull` is scheduled again when a chunk is enqueued, when a
 * new read arrives, or when the stream closes — and otherwise not at all. So a
 * `pull` that reads bytes, enqueues nothing and resolves ends the pull chain
 * permanently. The stream is still "readable", nothing has failed, and no
 * amount of waiting will produce another call.
 *
 * Two ordinary things make a read yield no event:
 *
 *   1. TCP splits an SSE frame, so the reframer is holding half of one.
 *   2. The frame is the usage chunk the gateway requested on the caller's
 *      behalf and strips again before forwarding.
 *
 * Neither can happen against a mock that writes one whole frame per chunk,
 * which is why the suite was green. `x-mock-split-at` makes the mock behave
 * like a real socket, and these tests fail — hang, then time out — against the
 * version of the gateway that shipped this bug.
 *
 * The general lesson is in the first line of the gateway's stream comment: a
 * proxy is only tested by an upstream that is allowed to be inconvenient.
 */

let stack: Awaited<ReturnType<typeof startStack>>;

beforeEach(async () => {
  stack = await startStack();
});
afterEach(async () => {
  await stack.close();
});

const SPLIT = { 'split-at': 12, chunks: 6, 'gap-ms': 5 } as const;

describe('an upstream that splits frames across reads', () => {
  it('still delivers every event to the caller', async () => {
    const res = await postChat(stack.gatewayUrl, { mock: SPLIT });

    let text = '';
    let sawDone = false;
    for await (const evt of readEvents(res)) {
      if (evt.data === '[DONE]') sawDone = true;
      text += evt.json?.choices?.[0]?.delta?.content ?? '';
    }

    expect(text).toBe(expectedText(6));
    expect(sawDone).toBe(true);
  }, 10_000);

  it('logs the stream as completed rather than stalling', async () => {
    const res = await postChat(stack.gatewayUrl, { mock: SPLIT });
    const id = res.headers.get('x-gateway-request-id')!;
    for await (const _ of readEvents(res)) void _;

    const rec = await waitForLog(stack.sink, id);
    expect(rec.terminalState).toBe('completed');
    expect(rec.chunkCount).toBe(6);
    expect(rec.responseBody).toBe(expectedText(6));
    // The usage frame is split too, so this also proves that stripping a frame
    // mid-stream does not end the pull chain.
    expect(rec.completionTokens).toBe(6);
  }, 10_000);

  it('satisfies the official SDK, which is stricter than fetch', async () => {
    const client = new OpenAI({
      baseURL: `${stack.gatewayUrl}/v1`,
      apiKey: TEST_KEY,
      maxRetries: 0,
      fetch: globalThis.fetch,
    });

    const stream = await client.chat.completions.create(
      { model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { headers: { 'x-mock-split-at': '12', 'x-mock-chunks': '6', 'x-mock-gap-ms': '5' } },
    );

    let text = '';
    for await (const part of stream) text += part.choices?.[0]?.delta?.content ?? '';
    expect(text).toBe(expectedText(6));
  }, 10_000);
});
