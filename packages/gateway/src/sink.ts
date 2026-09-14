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
  /** How many batches may be in flight at once. See the note on throughput. */
  concurrency?: number;
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
 *
 * On throughput: drain rate is `batchSize × concurrency / intervalMs`, and it is
 * the first ceiling this system hits — well before SQLite or the proxy itself.
 * With one batch of 50 every 250ms it was 200 records/sec. Allowing several
 * batches in flight matters more than the batch size, because the limit is
 * round-trip latency rather than bytes. See docs/scaling.md.
 */
export class HttpSink implements LogSink {
  #queue: LogRecord[] = [];
  #dropped = 0;
  #timer: NodeJS.Timeout;
  #inFlight = 0;
  readonly #opts: Required<HttpSinkOptions>;

  constructor(opts: HttpSinkOptions) {
    this.#opts = {
      maxQueue: 10_000,
      batchSize: 200,
      intervalMs: 250,
      concurrency: 4,
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

  /** Fills every free concurrency slot from the queue. */
  async #drain(): Promise<void> {
    const sending: Array<Promise<void>> = [];
    while (this.#inFlight < this.#opts.concurrency && this.#queue.length > 0) {
      sending.push(this.#send(this.#queue.splice(0, this.#opts.batchSize)));
    }
    await Promise.all(sending);
  }

  async #send(batch: LogRecord[]): Promise<void> {
    this.#inFlight += 1;
    try {
      const res = await fetch(this.#opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-secret': this.#opts.secret },
        // The drop count rides the batch rather than getting its own endpoint:
        // it is monotonic, so whatever arrives last is correct, and a backend
        // that was down learns the number on the first batch that gets through.
        body: JSON.stringify({ records: batch, droppedTotal: this.#dropped }),
      });
      if (!res.ok) throw new Error(`ingest responded ${res.status}`);
    } catch {
      // Back to the front, so a transient failure costs ordering rather than
      // data. Ordering across concurrent batches is best-effort by definition —
      // the backend's INSERT OR REPLACE on a caller-supplied id is what makes
      // that safe, and the dashboard sorts by started_at regardless.
      this.#queue.unshift(...batch);
    } finally {
      this.#inFlight -= 1;
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
