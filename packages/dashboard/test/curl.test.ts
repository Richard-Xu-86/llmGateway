import { describe, expect, it } from 'vitest';
import type { LogRecord } from '@gw/shared';
import { toCurl } from '../src/lib/api';

/**
 * "Copy as cURL" makes one claim: paste it and the request happens again.
 *
 * It is easy to satisfy that accidentally and still be wrong, because the
 * captured headers are everything-minus-secrets — right for a log, wrong for a
 * command. Replaying the SDK's telemetry is merely noisy; replaying
 * `content-length` is a trap, since it stays correct only until someone edits
 * the body, which is the main reason to copy the command in the first place.
 */

const record = (over: Partial<LogRecord> = {}): LogRecord => ({
  id: 'r1',
  apiKeyId: 'k1',
  apiKeyName: 'demo-app',
  startedAt: Date.now(),
  method: 'POST',
  url: 'http://localhost:4000/v1/chat/completions',
  upstreamUrl: 'https://api.openai.com/v1/chat/completions',
  path: '/v1/chat/completions',
  model: 'gpt-4o-mini',
  isStream: true,
  requestHeaders: {
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate',
    'accept-language': '*',
    authorization: '[redacted]',
    connection: 'keep-alive',
    'content-length': '142',
    'content-type': 'application/json',
    host: 'localhost:4000',
    'sec-fetch-mode': 'cors',
    'user-agent': 'OpenAI/JS 4.104.0',
    'x-stainless-arch': 'arm64',
    'x-stainless-os': 'MacOS',
    'x-stainless-retry-count': '0',
  },
  requestBody: '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"hi"}]}',
  requestBodyTruncated: false,
  status: 200,
  responseHeaders: {},
  responseBody: 'hello',
  responseBodyTruncated: false,
  durationMs: 2528,
  ttftMs: 1435,
  chunkCount: 5,
  promptTokens: 13,
  completionTokens: 7,
  terminalState: 'completed',
  finishReason: 'stop',
  error: null,
  ...over,
});

describe('copy as cURL', () => {
  it('targets the gateway, not the upstream', () => {
    // The command has to go back through the proxy with a gateway key. Aimed at
    // api.openai.com it would carry the wrong credential — a command that looks
    // right and always fails.
    const cmd = toCurl(record());
    expect(cmd).toContain('curl -N http://localhost:4000/v1/chat/completions');
    expect(cmd).not.toContain('api.openai.com');
  });

  it('never prints the key', () => {
    const cmd = toCurl(record());
    expect(cmd).toContain('Authorization: Bearer $GATEWAY_API_KEY');
    expect(cmd).not.toContain('[redacted]'); // nor the placeholder we stored
  });

  it('drops content-length, so the command survives being edited', () => {
    // The whole point of copying is to change something and re-run. A stale
    // length means the server reads only the declared bytes and hangs or errors.
    expect(toCurl(record())).not.toContain('content-length');
  });

  it('drops headers that describe a connection or a client that is gone', () => {
    const cmd = toCurl(record());
    // Matched as whole `-H` lines: the URL itself contains "localhost:4000",
    // which a bare substring check for "host:" would hit.
    for (const gone of ['connection', 'host', 'sec-fetch-mode', 'x-stainless-arch', 'accept-encoding', 'accept-language']) {
      expect(cmd).not.toContain(`-H "${gone}:`);
    }
  });

  it('keeps what the request actually needs', () => {
    const cmd = toCurl(record());
    expect(cmd).toContain('-H "content-type: application/json"');
    expect(cmd).toContain('-H "accept: application/json"');
    expect(cmd).toContain('"role":"user"');
  });

  it('keeps user-agent, because the gateway forwards it upstream', () => {
    // Not noise: `user-agent` is on the gateway's forward allowlist, so it is
    // part of the request's identity as far as this system is concerned. A
    // replay that drops it is not replaying the same request.
    expect(toCurl(record())).toContain('-H "user-agent: OpenAI/JS 4.104.0"');
  });

  it('is four header lines plus the body, not sixteen', () => {
    // Readability is the feature. If this number creeps up, something is being
    // replayed that should not be.
    const headerLines = toCurl(record()).split('\n').filter((l) => l.includes('-H '));
    expect(headerLines).toHaveLength(4); // authorization, accept, content-type, user-agent
  });

  it('escapes a quote in the body rather than ending the argument early', () => {
    const cmd = toCurl(record({ requestBody: `{"content":"it's fine"}` }));
    expect(cmd).toContain(`it'\\''s fine`);
  });

  it('leaves no trailing backslash when there is no body', () => {
    // A dangling \ makes the shell wait for a line that never comes.
    const cmd = toCurl(record({ requestBody: null, method: 'GET' }));
    expect(cmd.endsWith('\\')).toBe(false);
  });
});
