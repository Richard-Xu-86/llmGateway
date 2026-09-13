/**
 * Re-frames a byte stream into whole SSE events.
 *
 * TCP does not respect message boundaries: one read can contain half an event,
 * three events, or an event split through the middle of a multi-byte character.
 * Everything downstream assumes whole events, so this is the only place that
 * has to think about it.
 *
 * Each returned string is the *original* event text including its trailing
 * blank line, so forwarding it re-encodes to the exact bytes that arrived.
 */
export class SseReframer {
  #decoder = new TextDecoder();
  #buf = '';

  /** Feed raw bytes; get back zero or more complete events. */
  push(chunk: Uint8Array): string[] {
    // `stream: true` is what keeps a 4-byte emoji split across two TCP reads
    // from being decoded as two replacement characters.
    this.#buf += this.#decoder.decode(chunk, { stream: true });

    const events: string[] = [];
    const boundary = /\r?\n\r?\n/g;
    let consumed = 0;
    let match: RegExpExecArray | null;

    while ((match = boundary.exec(this.#buf)) !== null) {
      const end = match.index + match[0].length;
      events.push(this.#buf.slice(consumed, end));
      consumed = end;
    }
    if (consumed > 0) this.#buf = this.#buf.slice(consumed);
    return events;
  }

  /** Flush whatever is left when the stream ends without a final blank line. */
  end(): string[] {
    this.#buf += this.#decoder.decode();
    const tail = this.#buf;
    this.#buf = '';
    return tail.trim().length > 0 ? [tail] : [];
  }
}

/**
 * Pull the `data:` payload out of one event, joining multi-line data fields
 * per the SSE spec. Returns null for comments and keep-alives.
 */
export function parseEventData(rawEvent: string): string | null {
  const data: string[] = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length > 0 ? data.join('\n') : null;
}
