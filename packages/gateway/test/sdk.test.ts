import http from 'node:http';
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_KEY, startStack } from './helpers.ts';

/**
 * The compatibility tests, run against the official `openai` SDK.
 *
 * Everything else here drives the gateway with `fetch`, which is forgiving: it
 * will happily read a body that simply stops. Real SDK clients are not. This
 * suite exists because a header the gateway should never have set
 * (`connection: keep-alive`, hop-by-hop) made Node stop managing its own
 * response framing, so the chunked terminator went unwritten — invisible to
 * curl and to fetch, and an immediate `ERR_STREAM_PREMATURE_CLOSE` to the SDK.
 *
 * The lesson generalised: a proxy is only correct if a strict client agrees.
 */

let stack: Awaited<ReturnType<typeof startStack>>;
let client: OpenAI;

beforeEach(async () => {
  stack = await startStack();
  client = new OpenAI({ baseURL: `${stack.gatewayUrl}/v1`, apiKey: TEST_KEY, maxRetries: 0 });
});
afterEach(async () => {
  await stack.close();
});

describe('the official OpenAI SDK', () => {
  it('streams to completion without a framing error', async () => {
    const stream = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });

    let text = '';
    let chunks = 0;
    // A premature close throws here rather than ending the loop, which is
    // exactly the failure this suite is guarding against.
    for await (const part of stream) {
      const piece = part.choices?.[0]?.delta?.content ?? '';
      if (piece) {
        text += piece;
        chunks += 1;
      }
    }

    expect(chunks).toBe(8); // the mock's default
    expect(text).toBe('tok0 tok1 tok2 tok3 tok4 tok5 tok6 tok7 ');
  });

  it('never shows the caller the usage chunk the gateway asked for', async () => {
    const stream = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });

    for await (const part of stream) {
      // The gateway adds stream_options.include_usage on the caller's behalf and
      // strips the resulting chunk. If it leaked, `usage` would appear here.
      expect((part as { usage?: unknown }).usage ?? null).toBeNull();
    }
  });

  it('handles a non-streaming completion', async () => {
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.choices[0]?.message.content).toContain('tok0');
  });

  it('surfaces an auth failure as an SDK error', async () => {
    const wrong = new OpenAI({ baseURL: `${stack.gatewayUrl}/v1`, apiKey: 'nope', maxRetries: 0 });
    await expect(
      wrong.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow();
  });
});

describe('response framing', () => {
  it('lets the runtime own hop-by-hop headers', async () => {
    const url = new URL(`${stack.gatewayUrl}/v1/chat/completions`);

    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.request(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            authorization: `Bearer ${TEST_KEY}`,
            'content-type': 'application/json',
            'x-mock-chunks': '3',
            'x-mock-gap-ms': '2',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.headers));
        },
      );
      req.on('error', reject);
      req.end(
        JSON.stringify({ model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      );
    });

    // Chunked framing is what tells a client where the body ends. Without it the
    // body is terminated only by the socket closing, which strict parsers reject.
    expect(headers['transfer-encoding']).toBe('chunked');
    expect(headers['content-length']).toBeUndefined();
    expect(headers['content-type']).toContain('text/event-stream');
  });
});
