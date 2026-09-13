import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OTHER_KEY, TEST_KEY, postChat, readEvents, startStack, waitForLog } from './helpers.ts';
import { authenticate, parseKeySpec, sha256 } from '@gw/shared/keys';

describe('key store', () => {
  const SECRET_ONE = 'gw_live_5f3a9c21b7e4d8006aa1';
  const SECRET_TWO = 'gw_live_11c2ee90a4f3b7d5ce88';
  const keys = parseKeySpec(`demo-app:${SECRET_ONE},agent-runner:${SECRET_TWO}`);

  it('stores a hash and a display tail, never the secret', () => {
    expect(keys[0]!.hash).toBe(sha256(SECRET_ONE));
    expect(JSON.stringify(keys)).not.toContain(SECRET_ONE);
    expect(keys[0]!.last4).toBe('6aa1');
  });

  it('accepts a valid bearer token and rejects everything else', () => {
    expect(authenticate(keys, `Bearer ${SECRET_ONE}`)?.name).toBe('demo-app');
    expect(authenticate(keys, `bearer ${SECRET_TWO}`)?.name).toBe('agent-runner');
    expect(authenticate(keys, 'Bearer nope')).toBeNull();
    expect(authenticate(keys, SECRET_ONE)).toBeNull(); // no Bearer scheme
    expect(authenticate(keys, undefined)).toBeNull();
  });
});

describe('gateway auth', () => {
  let stack: Awaited<ReturnType<typeof startStack>>;
  beforeEach(async () => {
    stack = await startStack();
  });
  afterEach(async () => {
    await stack.close();
  });

  it('rejects a request with no key', async () => {
    const res = await fetch(`${stack.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('invalid_api_key');
  });

  it('rejects an unknown key', async () => {
    const res = await postChat(stack.gatewayUrl, { key: 'gw_live_not_a_real_key' });
    expect(res.status).toBe(401);
  });

  it('attributes each request to the key that made it', async () => {
    const a = await postChat(stack.gatewayUrl, { key: TEST_KEY, mock: { chunks: 1, 'gap-ms': 1 } });
    const aId = a.headers.get('x-gateway-request-id')!;
    for await (const _ of readEvents(a)) void _;

    const b = await postChat(stack.gatewayUrl, { key: OTHER_KEY, mock: { chunks: 1, 'gap-ms': 1 } });
    const bId = b.headers.get('x-gateway-request-id')!;
    for await (const _ of readEvents(b)) void _;

    const recA = await waitForLog(stack.sink, aId);
    const recB = await waitForLog(stack.sink, bId);

    expect(recA.apiKeyName).toBe('demo-app');
    expect(recB.apiKeyName).toBe('other-app');
    expect(recA.apiKeyId).not.toBe(recB.apiKeyId);
  });
});
