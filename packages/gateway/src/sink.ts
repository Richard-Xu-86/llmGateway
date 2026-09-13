import type { LogRecord } from '@gw/shared';

/**
 * Where finished log records go.
 *
 * `write` is synchronous and must never throw: it is called at the moment a
 * response finishes, and a gateway must never fail a paid request to save a
 * log line. Everything slow happens on a timer behind this interface.
 *
 * It is also the seam the isolation test uses — swap in a sink that sleeps for
 * three seconds and the caller's stream timings must not move.
 */
export interface LogSink {
  write(record: LogRecord): void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    this.records.push(record);
  }
  byId(id: string): LogRecord | undefined {
    return this.records.find((r) => r.id === id);
  }
}

export interface HttpSinkOptions {
  url: string;
  secret: string;
  maxQueue?: number;
  batchSize?: number;
  intervalMs?: number;
}

/**
 * Ships records to the backend over REST, off the request path.
 *
 * Bounded on purpose. Under sustained back-pressure it drops the oldest
 * records and counts them, rather than growing without limit or blocking the
 * proxy. That is a real tradeoff: delivery is at-most-once, and an ungraceful
 * crash loses whatever is still queued. A production version writes to a local
 * WAL or a broker instead. The dropped counter is exposed so the loss is
 * visible rather than silent.
 */
export class HttpSink implements LogSink {
  #queue: LogRecord[] = [];
  #dropped = 0;
  #timer: NodeJS.Timeout;
  #inFlight = false;
  readonly #opts: Required<HttpSinkOptions>;

  constructor(opts: HttpSinkOptions) {
    this.#opts = {
      maxQueue: 10_000,
      batchSize: 50,
      intervalMs: 250,
      ...opts,
    };
    this.#timer = setInterval(() => void this.#drain(), this.#opts.intervalMs);
    this.#timer.unref?.();
  }

  get dropped(): number {
    return this.#dropped;
  }

  write(record: LogRecord): void {
    if (this.#queue.length >= this.#opts.maxQueue) {
      this.#queue.shift();
      this.#dropped++;
    }
    this.#queue.push(record);
  }

  async #drain(): Promise<void> {
    if (this.#inFlight || this.#queue.length === 0) return;
    this.#inFlight = true;
    const batch = this.#queue.splice(0, this.#opts.batchSize);
    try {
      const res = await fetch(this.#opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-secret': this.#opts.secret },
        body: JSON.stringify({ records: batch }),
      });
      if (!res.ok) throw new Error(`ingest responded ${res.status}`);
    } catch {
      // Put them back at the front so ordering survives a transient failure.
      this.#queue.unshift(...batch);
    } finally {
      this.#inFlight = false;
    }
  }

  async flush(): Promise<void> {
    while (this.#queue.length > 0) {
      const before = this.#queue.length;
      await this.#drain();
      if (this.#queue.length >= before) break; // not making progress; stop
    }
  }

  async close(): Promise<void> {
    clearInterval(this.#timer);
    await this.flush();
  }
}
