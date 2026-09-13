import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UPSTREAM_SECRET, postChat, readEvents, sleep, startStack, waitForLog } from './helpers.ts';

let stack: Awaited<ReturnType<typeof startStack>>;

beforeEach(async () => {
  stack = await startStack();
});
afterEach(async () => {
  await stack.close();
});

async function drain(res: Response) {
  const events = [];
  for await (const evt of readEvents(res)) events.push(evt);
  return events;
}

describe('what gets written down', () => {
  it('captures request, response, timing and tokens', async () => {
    const res = await postChat(stack.gatewayUrl, { mock: { chunks: 4, 'gap-ms': 10 } });
    const id = res.headers.get('x-gateway-request-id')!;
    await drain(res);

    const rec = await waitForLog(stack.sink, id);
    expect(rec.method).toBe('POST');
    expect(rec.path).toBe('/v1/chat/completions');
    expect(rec.model).toBe('gpt-4o-mini');
    expect(rec.isStream).toBe(true);
    expect(rec.status).toBe(200);
    expect(rec.terminalState).toBe('completed');
    expect(rec.chunkCount).toBe(4);
    expect(rec.responseBody).toBe('tok0 tok1 tok2 tok3 ');
    expect(rec.durationMs).toBeGreaterThan(0);
    expect(rec.ttftMs).toBeGreaterThanOrEqual(0);
    expect(rec.requestBody).toContain('"messages"');
    expect(rec.apiKeyName).toBe('demo-app');
  });

  it('never stores the caller key or the upstream key', async () => {
    const res = await postChat(stack.gatewayUrl, { mock: { chunks: 2, 'gap-ms': 5 } });
    const id = res.headers.get('x-gateway-request-id')!;
    await drain(res);

    const rec = await waitForLog(stack.sink, id);
    expect(rec.requestHeaders['authorization']).toBe('[redacted]');

    const serialised = JSON.stringify(rec);
    expect(serialised).not.toContain(UPSTREAM_SECRET);
    expect(serialised).not.toContain('gw_test_key_alpha');
  });
});

describe('token usage on streams', () => {
  it('captures usage without the caller seeing the extra chunk', async () => {
    // The caller did not ask for usage, so the gateway asks on their behalf and
    // removes the chunk again on the way out.
    const res = await postChat(stack.gatewayUrl, { mock: { chunks: 5, 'gap-ms': 5 } });
    const id = res.headers.get('x-gateway-request-id')!;

    const events = await drain(res);
    const usageVisibleToCaller = events.some((e) => e.json?.usage !== undefined);
    expect(usageVisibleToCaller).toBe(false);
    // Every chunk the caller saw still has a choices array — nothing odd leaked through.
    for (const e of events) {
      if (e.json) expect(Array.isArray(e.json.choices) && e.json.choices.length > 0).toBe(true);
    }

    const rec = await waitForLog(stack.sink, id);
    expect(rec.promptTokens).toBe(11);
    expect(rec.completionTokens).toBe(5);
  });

  it('leaves the stream alone when the caller asked for usage themselves', async () => {
    const res = await postChat(stack.gatewayUrl, {
      mock: { chunks: 3, 'gap-ms': 5 },
      body: { stream_options: { include_usage: true } },
    });
    const events = await drain(res);
    expect(events.some((e) => e.json?.usage !== undefined)).toBe(true);
  });

  it('can be switched off entirely', async () => {
    const plain = await startStack({ injectUsage: false });
    try {
      const res = await postChat(plain.gatewayUrl, { mock: { chunks: 3, 'gap-ms': 5 } });
      const id = res.headers.get('x-gateway-request-id')!;
      for await (const _ of readEvents(res)) void _;
      const rec = await waitForLog(plain.sink, id);
      expect(rec.completionTokens).toBeNull();
    } finally {
      await plain.close();
    }
  });
});

describe('failures the status code hides', () => {
  it('records an in-band mid-stream error even though the status was 200', async () => {
    const res = await postChat(stack.gatewayUrl, {
      mock: { chunks: 10, 'gap-ms': 5, 'fail-after': 3 },
    });
    const id = res.headers.get('x-gateway-request-id')!;
    expect(res.status).toBe(200); // the lie

    const events = await drain(res);
    expect(events.some((e) => e.json?.error)).toBe(true);

    const rec = await waitForLog(stack.sink, id);
    expect(rec.status).toBe(200);
    expect(rec.terminalState).toBe('upstream_error'); // the truth
    expect(rec.error).toContain('exploded mid-stream');
  });

  it('records a non-2xx upstream response', async () => {
    const res = await postChat(stack.gatewayUrl, { mock: { status: 429 } });
    const id = res.headers.get('x-gateway-request-id')!;
    await res.text();

    const rec = await waitForLog(stack.sink, id);
    expect(rec.status).toBe(429);
    expect(rec.terminalState).toBe('upstream_error');
  });
});

describe('client disconnect', () => {
  it('cancels the upstream call instead of paying for the rest', async () => {
    const controller = new AbortController();
    const mockRequestId = `abort-${Date.now()}`;

    const res = await postChat(stack.gatewayUrl, {
      mock: { chunks: 60, 'gap-ms': 20, 'request-id': mockRequestId },
      signal: controller.signal,
    });
    const id = res.headers.get('x-gateway-request-id')!;

    let seen = 0;
    try {
      for await (const evt of readEvents(res)) {
        if (typeof evt.json?.emittedAt === 'number' && ++seen === 3) {
          controller.abort();
          break;
        }
      }
    } catch {
      // aborting mid-read throws; that is the point
    }

    await sleep(400);

    const stats = await stack.mockStats(mockRequestId);
    expect(stats).not.toBeNull();
    expect(stats!.aborted).toBe(true);
    // Without abort propagation the mock would have run all 60 chunks by now.
    expect(stats!.emitted as number).toBeLessThan(20);

    const rec = await waitForLog(stack.sink, id);
    expect(rec.terminalState).toBe('client_aborted');
  });
});

/*
 * Back-pressure is deliberately NOT asserted end-to-end here, and that is worth
 * explaining rather than quietly omitting.
 *
 * The gateway's own behaviour is structural: its response body is a pull-driven
 * ReadableStream, so it reads from upstream only when the caller has room. But
 * a test can only observe the far end of the chain, and between the two sit the
 * mock's Node HTTP adapter, two kernel socket buffers, and undici's response
 * buffer. The mock's adapter does not itself honour write back-pressure, so it
 * keeps producing into those buffers regardless of what the gateway does —
 * which means a test written against the mock's emitted-chunk count measures
 * the mock, not the gateway, and fails for the wrong reason.
 *
 * What IS asserted: the gateway never holds a whole response (streaming-timing),
 * and it cancels upstream the moment the caller leaves (client disconnect).
 */

describe('non-streaming requests', () => {
  it('proxies and logs them too', async () => {
    const res = await postChat(stack.gatewayUrl, {
      mock: { chunks: 3, 'gap-ms': 1 },
      body: { stream: false },
    });
    const id = res.headers.get('x-gateway-request-id')!;
    const json = (await res.json()) as any;

    expect(json.choices[0].message.content).toBe('tok0 tok1 tok2 ');

    const rec = await waitForLog(stack.sink, id);
    expect(rec.isStream).toBe(false);
    expect(rec.ttftMs).toBeNull();
    expect(rec.completionTokens).toBe(3);
    expect(rec.terminalState).toBe('completed');
  });
});
