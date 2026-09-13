import { describe, expect, it } from 'vitest';
import { SseReframer, parseEventData } from '../src/sse.ts';

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

describe('SseReframer', () => {
  it('returns a whole event from a whole chunk', () => {
    const r = new SseReframer();
    expect(r.push(bytes('data: {"a":1}\n\n'))).toEqual(['data: {"a":1}\n\n']);
  });

  it('holds an event split across several reads until it is complete', () => {
    const r = new SseReframer();
    expect(r.push(bytes('data: {"a'))).toEqual([]);
    expect(r.push(bytes('":1}'))).toEqual([]);
    expect(r.push(bytes('\n\n'))).toEqual(['data: {"a":1}\n\n']);
  });

  it('splits several events arriving in one read', () => {
    const r = new SseReframer();
    expect(r.push(bytes('data: 1\n\ndata: 2\n\ndata: 3\n\n'))).toEqual([
      'data: 1\n\n',
      'data: 2\n\n',
      'data: 3\n\n',
    ]);
  });

  it('accepts CRLF framing', () => {
    const r = new SseReframer();
    expect(r.push(bytes('data: 1\r\n\r\n'))).toEqual(['data: 1\r\n\r\n']);
  });

  it('does not corrupt a multi-byte character split across a read boundary', () => {
    // The single most common way a logging proxy silently mangles its own logs.
    const r = new SseReframer();
    const full = enc.encode('data: {"content":"héllo 👋"}\n\n');
    const cut = 20; // lands inside the emoji's 4 bytes
    r.push(full.subarray(0, cut));
    const events = r.push(full.subarray(cut));
    expect(events).toEqual(['data: {"content":"héllo 👋"}\n\n']);
    expect(parseEventData(events[0]!)).toContain('👋');
  });

  it('forwarded events re-encode to the original bytes', () => {
    const r = new SseReframer();
    const original = 'data: {"x":"ünïcødé 🎉"}\n\ndata: [DONE]\n\n';
    const out = r.push(bytes(original)).join('');
    expect(enc.encode(out)).toEqual(enc.encode(original));
  });

  it('surfaces a trailing event when the stream ends without a blank line', () => {
    const r = new SseReframer();
    expect(r.push(bytes('data: [DONE]'))).toEqual([]);
    expect(r.end()).toEqual(['data: [DONE]']);
  });
});

describe('parseEventData', () => {
  it('joins multi-line data fields', () => {
    expect(parseEventData('data: one\ndata: two\n\n')).toBe('one\ntwo');
  });

  it('ignores comments and keep-alives', () => {
    expect(parseEventData(': keep-alive\n\n')).toBeNull();
  });

  it('reads the DONE sentinel', () => {
    expect(parseEventData('data: [DONE]\n\n')).toBe('[DONE]');
  });
});
