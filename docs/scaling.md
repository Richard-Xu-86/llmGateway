# Scaling to a million requests per second

A design exercise, worked from arithmetic rather than adjectives. The short
version: the proxy scales by buying machines, and the logging plane does not
scale at all in its current shape — at a million requests per second you cannot
keep one stored record per request, and no choice of database changes that.

## 1. What the number actually means

| | |
|---|---|
| Requests | 1,000,000 / sec |
| Average stream duration | ~5 s |
| **Concurrent open connections** | **~5,000,000** |
| Average stored record today | ~4 KB (headers, prompt, reassembled response) |
| **Log volume** | **4 GB/s → 345 TB/day → ~10 PB/month** |
| Output tokens, at ~500 per response | 500,000,000 tokens/sec |

Two of those deserve a pause.

**5 million concurrent connections.** This is a streaming proxy, so a request is
not a transaction that completes in 20ms — it is a socket held open for seconds.
Concurrency, not request rate, is what sizes the proxy tier.

**500M output tokens/sec** exceeds global inference capacity by orders of
magnitude, so no single provider will ever serve this from one gateway. The
realistic version of "a million requests per second" is a gateway fronting many
providers and many self-hosted models, or a number that is aspirational. It
doesn't change the engineering below, but it's worth saying rather than
designing for a figure nobody examined.

## 2. The reframe: two planes, not one

Today every request produces exactly one `LogRecord`, and that record carries
full bodies. That is the right design at thousands of requests per second and
the wrong one at a million, because it couples two things with completely
different economics:

- **Metrics** — how many, how fast, how many tokens, how many failed. Needed for
  *every* request, forever. Tiny, and aggregable: a thousand requests collapse
  into one row of counters and histogram buckets.
- **Traces** — the actual prompt and the actual response. Needed for a *few*
  requests, for a short time. Large, and not aggregable at all.

Trying to serve both from one record is what produces 345 TB/day. Splitting them
is the single highest-leverage change, and it is worth roughly 100× before any
infrastructure is touched:

```
metrics : aggregated in-process, flushed every 10s per instance
          200 instances × 6 flushes/min ≈ 20 writes/sec total
traces  : sampled — 100% of errors, 100% of slow, ~0.5% of the rest
          1M rps → ~10k rps of full records
```

The sampling decision is made **when the request arrives**, not when it
finishes. That matters for more than storage: an unsampled request never
accumulates response text in memory at all, so `StreamCapture` stops being a
per-connection memory cost across 5M connections.

Tail-based sampling — decide after you know the outcome — is better but needs
the record buffered until then. The compromise most systems land on: head-based
by default, plus a rule that any request which errors or exceeds a latency
threshold is retroactively promoted, which requires buffering only the tail of
in-flight requests.

## 3. Bottlenecks, in the order they break

| # | Layer | Ceiling today | Why it breaks | Fix |
|---|---|---|---|---|
| 1 | Log shipping | **200 records/sec** | `batchSize 50` every `250ms`, one request in flight | concurrency + larger batches → ~10k/s |
| 2 | Queue durability | in-memory, bounded | a crash loses the queue; at 1M rps an outage is catastrophic | Kafka / Redis Streams, partitioned by `api_key_id` |
| 3 | Log volume | 4 GB/s | physics and cost, not software | metrics/trace split + sampling (§2) |
| 4 | Storage | SQLite: one writer, one machine | no horizontal scaling, no HA | ClickHouse for metadata, object storage for bodies |
| 5 | Key auth | linear scan per request | O(keys) on the hot path | hashmap + local LRU over Redis, or signed keys needing no lookup |
| 6 | Gateway process | ~5–10k rps, ~20–50k sockets | one process, one core | stateless → 100–250 instances behind an L4 balancer |
| 7 | Dashboard queries | `url LIKE '%q%'` scans | no index can serve it at 10¹¹ rows | pre-aggregated rollups; skip indexes; search over sampled traces only |
| 8 | Backend process | single instance | no HA for reads | stateless read replicas; ingest and query separated |

Note the ordering. The first thing to break is a constant in `sink.ts`, and it
breaks at **200/sec** — five thousand times below the target, and fixable in
about fifteen lines. The last things to break are the ones people reach for
first.

## 4. Target architecture

```
          ┌──────────┐   ┌──────────┐        ┌───────────────┐
clients → │ gateway  │ … │ gateway  │  ───→  │ provider pool │
          │ (×200)   │   │ (×200)   │        │ OpenAI, self- │
          └────┬─────┘   └────┬─────┘        │ hosted, …     │
               │  metrics (aggregated, 10s)  └───────────────┘
               │  traces  (sampled, ~1%)
               ▼
        ┌──────────────┐
        │ Kafka        │  partitioned by api_key_id
        └──────┬───────┘
               ├──────────────→ ClickHouse   (metadata + rollups, queryable)
               └──────────────→ S3           (bodies, keyed by request id)
                                   ▲
                         ┌─────────┴────────┐
                         │ query API (×N)   │ ──→ dashboard
                         └──────────────────┘
```

Four properties worth naming:

**The gateway stays stateless.** It holds no session, no counters that must be
exact, no database handle. That is what makes instance count a purchasing
decision rather than an engineering one — and it is already true today.

**Partitioning by `api_key_id`** keeps one tenant's traffic on one partition, so
per-key ordering survives and per-key rate limiting can be computed locally.

**Bodies never enter the database.** ClickHouse stores an S3 key, not 4 KB of
prompt. This is what turns a 4 GB/s write problem into a 200 MB/s one, and it
also makes retention a lifecycle rule rather than a `DELETE`.

**Query is separated from ingest.** They have opposite access patterns —
append-only versus wide scans — and at this scale they must not contend for the
same machine.

## 5. What changes in this repository

Less than you'd expect, and that is the point of the seams that already exist.

**Unchanged:** `sse.ts`, `capture.ts`, the pull-driven streaming loop, the
terminal-state logic, the header allowlists, the tenancy rule. All of the actual
proxy correctness survives untouched.

**Interface, same shape, new implementation:**

```ts
export interface LogSink {
  write(record: LogRecord): void;   // sync, never throws
}
```

`HttpSink` becomes `KafkaSink`. Nothing above it changes, because nothing above
it knows how logs travel. Same for storage: `LogStore` is four methods —
`insert`, `query`, `get`, `stats` — and `ClickHouseStore` implements the same
four. **SQLite was a deployment decision, not an architectural one.**

**Genuinely new work:**

1. A sampling decision at request start, carried on the record
2. An in-process metrics aggregator (counters + HDR histograms per key/model, flushed on a timer)
3. Bodies written to object storage, with only a pointer in the row
4. Rollup tables so the dashboard reads pre-aggregated windows instead of scanning
5. A key store with caching, replacing the environment variable

## 6. A staged plan

Nobody goes from here to a million. The useful question is what you do at each
order of magnitude, and the answer is that the cheap fixes buy a surprising
amount of room.

| Scale | Work | Cost |
|---|---|---|
| **1k rps** | Fix the sink: concurrent batches, `batchSize` 200. Wrap inserts in a transaction. | ~15 lines |
| **10k rps** | Bodies to object storage. Add sampling. Two gateway instances behind a balancer. | a day |
| **100k rps** | Kafka replaces the in-memory queue. ClickHouse replaces SQLite. Metrics split from traces. | a sprint |
| **1M rps** | Rollups, key store with caching, multi-region, tail-based sampling. | a team |

The first row is worth doing today. It is fifteen lines and it moves the first
bottleneck from 200/sec to roughly 10,000/sec — a 50× improvement for
essentially no risk, which is not a ratio that comes up often.

## 7. What would actually be measured

Design arguments are cheap. These are the numbers that would decide whether any
of the above is working:

- **TTFT overhead added by the gateway**, p50 and p99. The proxy exists to be
  invisible; this is the number that says whether it is. Today's flat-overhead
  test measures exactly this and would carry over unchanged.
- **Sink drop rate.** Already counted and already surfaced in the dashboard. At
  scale it is the signal that observability is degrading before anyone notices
  the gaps.
- **Concurrent connections per instance**, against memory. This sizes the fleet,
  and it is the number that matters for a streaming proxy rather than rps.
- **Queue lag** — Kafka offset behind head. How stale the dashboard is.
- **Cost per million requests**, split into inference, egress and storage. The
  third of these is the one that surprises people, and it is the one sampling is
  there to control.

## 8. The honest caveat

At a million requests per second, a central proxy cluster may be the wrong shape
entirely. Every request pays an extra network hop, and the gateway becomes a
failure domain for every application in the company. The pattern large
deployments converge on is a **sidecar** — the proxy runs beside each client
application, and only the aggregation is central. Envoy plus an OpenTelemetry
collector is the mature version of that idea.

That is a different product from this one, and choosing it would be a decision
about operational topology rather than about code. Everything in §5 still
applies: the same streaming loop, the same capture, the same sink interface —
deployed as a sidecar instead of a service.
