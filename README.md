# LLM Gateway

An authenticating proxy that sits in front of the OpenAI API, records every
request and response, and streams the answer back untouched — plus a dashboard
for inspecting the traffic.

```
┌────────────┐  Authorization: Bearer gw_…  ┌──────────────┐  real OpenAI key  ┌────────────┐
│ client app │ ───────────────────────────► │   GATEWAY    │ ────────────────► │  OpenAI    │
│ (openai    │ ◄───────── SSE ───────────── │   (proxy)    │ ◄───── SSE ────── │  (or mock) │
│  SDK)      │                              └──────┬───────┘                   └────────────┘
└────────────┘                                     │ async batch POST /ingest
                                                   ▼
                                            ┌──────────────┐   WebSocket push   ┌────────────┐
                                            │ LOG BACKEND  │ ─────────────────► │ DASHBOARD  │
                                            │  + SQLite    │ ◄── REST queries ─ │  (React)   │
                                            └──────────────┘                    └────────────┘
```

## Quick start

No OpenAI key required, and no Docker, database or global tooling.

```bash
npm install
npm run dev      # starts the mock upstream + the gateway
```

In another terminal:

```bash
curl -N http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer gw_live_demo_key_1" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

Tokens arrive one at a time. `-N` matters: without it curl buffers and you will
blame the wrong component.

To talk to the real API instead, copy `.env.example` to `.env` and set
`UPSTREAM_BASE_URL=https://api.openai.com` plus your `OPENAI_API_KEY`. Any
OpenAI SDK works unchanged — point `baseURL` at `http://localhost:4000/v1`.

```bash
npm test         # 29 tests, ~6s, no network
npm run typecheck
```

## The problem worth describing

Everything here is ordinary CRUD except one thing: a streamed response is not a
body, it is a connection held open for tens of seconds dribbling tokens. Buffer
it in order to log it and the caller's UI stops streaming — the feature the
gateway exists to support is the feature it destroys. Forward it untouched and
there is nothing to log.

The resolution is to observe events as they pass rather than collect them:

```ts
const out = new ReadableStream({
  async pull(controller) {
    const { done, value } = await reader.read();
    for (const event of reframer.push(value)) {
      if (capture.observe(event)) controller.enqueue(encode(event));
    }
  },
  cancel() { capture.aborted = true; reader.cancel(); finish(); },
});
```

Three decisions are packed into that:

**Pull-driven, not a `TransformStream`.** `tee()` was the first instinct and it
is worse here: it creates two consumers of one source, so the stream runs at the
speed of the slower branch and an unconsumed branch deadlocks it outright. A
pull-driven readable has one consumer, so back-pressure runs from the caller's
socket to the upstream connection, and `cancel` gives an explicit hook that
`TransformStream` does not — which is how a caller hanging up becomes
`client_aborted` instead of an anonymous stream error.

**`observe` is on the hot path, so it does almost nothing.** Reframe, parse,
append, stamp a timestamp. Record assembly happens after the last byte is on the
wire. The test that enforces this asserts the sink is called exactly once per
request.

**Log shipping sits behind an interface.** `LogSink.write` is synchronous and
must never throw. A sink that blocks the event loop for 300ms does not move the
caller's per-chunk timings, and a sink that throws does not break the response —
both are asserted, because both are the actual claim being made.

## Four things that are easy to get wrong

**A streamed failure is still `200 OK`.** The status is committed before the
body exists, so a stream that dies at token 400 looks successful. The gateway
derives its own verdict — `completed` / `client_aborted` / `upstream_error` /
`truncated` — from whether `[DONE]` arrived, whether an error object appeared
in-band, and whether the caller left. This is the field that makes the dashboard
answer a question OpenAI's own status codes cannot.

**Streams carry no token usage.** Not unless the request sets
`stream_options.include_usage`. Rather than log zeros on exactly the calls people
most want to measure, the gateway adds the flag, reads the usage chunk, and
removes that chunk again if the caller did not ask for it. Usage is exact and the
caller's stream is unchanged. This is the one place the proxy is not
byte-transparent, it is disclosed here rather than buried, and
`injectUsage: false` turns it off.

**TCP does not respect message boundaries.** One read can hold half an event,
three events, or a cut through the middle of a 4-byte emoji. `SseReframer` is the
only component that has to know this; it decodes with `{ stream: true }` so a
split character does not silently corrupt the log, and it emits original event
text so forwarding re-encodes to the exact bytes that arrived.

**A client that hangs up is still being billed.** The caller's `AbortSignal` is
passed to the upstream `fetch`, and `cancel` cancels the upstream body. The test
asserts the mock stopped generating, not merely that the gateway returned.

## Tradeoffs

| Decision | Why | What it costs |
|---|---|---|
| SQLite via built-in `node:sqlite` | `npm install && npm run dev`, no server, no container, no native build step | single writer, single node; real log volume wants ClickHouse or Timescale, with Postgres as a stop on the way |
| Gateway and backend as separate processes | the proxy must not be slowed or taken down by the logging path | more moving parts than one process |
| Bounded in-memory queue for log shipping | no broker to install; back-pressure is explicit and drops are counted, not silent | at-most-once delivery — an ungraceful crash loses what is queued. A WAL or a broker fixes it |
| Pull-driven readable over `tee()` | one consumer, real back-pressure, an explicit cancel hook | the observer runs on the hot path, so it must stay trivial |
| Inject `include_usage`, strip the chunk | exact token counts without changing what the caller sees | the proxy is no longer purely transparent |
| Full bodies stored, truncated at 256 KB | inspecting them is the entire point of the tool | prompts are user data; production needs retention limits, field-level redaction and encryption at rest |
| SHA-256 for keys, not bcrypt | these are 128+ bits of random checked on every request; a slow KDF adds latency and buys nothing against an unguessable secret | wrong choice entirely for human-chosen passwords |
| Header allowlists in both directions | a header nobody thought about leaks nothing | an unusual header needs an explicit addition |

## Verification

The interesting tests are the ones that check the claim rather than the code.

Every mock chunk carries the timestamp it was emitted at, so `arrived - emitted`
is the gateway's transit cost for that chunk. Two shapes are possible: streaming
produces a small **flat** overhead across all chunks; buffering produces an
overhead equal to the whole generation time on chunk 0, decaying to zero on the
last. A flat line is the proof, and nothing else produces one.

| Test | What it proves |
|---|---|
| `streaming-timing` — flat overhead | per-chunk overhead spread < 100ms where buffering would be ~440ms |
| `streaming-timing` — slow tail | first chunk delivered in < 300ms of a stream that takes over a second |
| `sink-isolation` — blocking sink | a sink blocking 300ms does not move caller timings; sink called exactly once |
| `sink-isolation` — throwing sink | a logging failure never becomes a caller-facing failure |
| `sse` — split multi-byte char | an emoji cut across two reads is not corrupted in the log |
| `logging` — in-band error | `terminal_state = upstream_error` on a `200 OK` stream |
| `logging` — client disconnect | the upstream stopped generating, not just the gateway |
| `logging` — usage | exact tokens captured, caller's stream unchanged |
| `logging` — redaction | neither the caller's key nor the upstream key appears in a stored record |
| `auth` — attribution | each record carries the key that made it |

Back-pressure is deliberately not asserted end-to-end; the comment in
`logging.test.ts` explains why a test written against the mock would measure the
mock's HTTP adapter rather than the gateway, and what is asserted instead.

## Layout

```
packages/
  shared/        LogRecord zod schema — the contract all three services share
  mock-openai/   metronome upstream: timestamped SSE, controllable failures
  gateway/       the proxy
    src/sse.ts       reframes bytes into whole SSE events
    src/capture.ts   accumulates the log record as events fly past
    src/sink.ts      LogSink interface + memory and HTTP implementations
    src/auth.ts      key hashing and lookup
    src/app.ts       the proxy itself
```

## Status

Built and tested: the proxy, streaming, auth, capture, and the log sink
interface with both implementations.

Next: the backend (`/ingest`, SQLite, query API, WebSocket fan-out) and the
React dashboard (login, live table, detail drawer, filters).

## Further work

Per-key rate limits and budgets; provider fan-out behind one OpenAI-shaped API;
response caching; session/trace grouping so a whole agent run reads as one tree
instead of forty loose rows; PII scrubbing before storage; OpenTelemetry export.

## AI assistance

_(Describe here how Copilot / Claude / ChatGPT were used — the brief asks, and a
straight answer reads better than a vague one.)_
