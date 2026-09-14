# LLM Gateway

An authenticating proxy in front of the OpenAI API that records every request
and response, streams the answer back untouched, and a dashboard for inspecting
the traffic live.

![The live request table, with one request open on its timing breakdown](docs/dashboard.png)

Client apps point their OpenAI SDK at the gateway instead of `api.openai.com`.
The gateway checks their *gateway* key, forwards the call with the *real* key
held server-side, streams the answer straight back — and, off the hot path,
records what happened.

```mermaid
sequenceDiagram
    autonumber
    participant App as client app
    participant GW as gateway :4000
    participant AI as OpenAI
    participant BE as backend :4020
    participant UI as dashboard :5173

    App->>GW: POST /v1/chat/completions<br/>Bearer gw_live_…
    Note over GW: key checked against the issued list<br/>no match → 401, upstream never dialled
    GW->>AI: same body, same path<br/>Bearer sk-…

    loop every SSE frame
        AI-->>GW: data: {"delta":{"content":"…"}}
        GW-->>App: forwarded byte-for-byte, immediately
        Note right of GW: reframed, then copied into<br/>the capture on the way past
    end

    AI-->>GW: data: [DONE]
    GW-->>App: stream closes — the caller is finished here
    Note over App,GW: everything above is the hot path.<br/>a person is waiting on every millisecond of it.

    GW->>GW: sink.write(record) — push onto an array, return void
    Note over GW,BE: measured 98 ms later, with the caller long gone
    GW->>BE: POST /ingest (batched, every 250 ms, fire-and-forget)
    BE->>BE: INSERT OR REPLACE into SQLite
    BE-->>UI: push the row over WebSocket
    UI->>BE: GET /api/logs for history (separate pipe)
```

The gateway never touches the database and the backend never talks to OpenAI, so
nothing on the second half of that diagram can fail in a way the caller feels.
[`docs/architecture.html`](docs/architecture.html) lays the same system out as a
single page, with the failure modes and terminal states beside it.

## Quick start

No OpenAI key, no Docker, no database, no global tooling. Node 22+ is the only
prerequisite — `node:sqlite` is built into the runtime, so nothing compiles at
install time.

```bash
npm install
npm run dev      # mock upstream, gateway, log backend, dashboard
```

Open **http://localhost:5173** and sign in with `gw_live_demo_key_1`. Then, in a
second terminal:

```bash
npm run ask -- "what is a FIFO buffer?"
```

```bash
npm test         # 89 tests, ~11s, no network, no API key
npm run typecheck
```

Any OpenAI SDK works unchanged — point `baseURL` at `http://localhost:4000/v1`
and use a gateway key. To reach the real API, copy `.env.example` to `.env` and
set `UPSTREAM_BASE_URL=https://api.openai.com` with your `OPENAI_API_KEY`.

## What the brief asked for

| From the brief | Where | Proven by |
|---|---|---|
| Capture method, URL, headers, body | `gateway/src/app.ts` | `logging.test.ts` |
| Response status, headers, body, latency | `gateway/src/capture.ts` | `logging.test.ts` |
| Logs shipped asynchronously | `gateway/src/sink.ts` → `backend/src/app.ts` | `sink-isolation.test.ts` |
| Streaming via Server-Sent Events | `gateway/src/sse.ts`, `app.ts` | `streaming-timing.test.ts`, `sse.test.ts` |
| Authenticate via API key | `shared/src/keys.ts` | `auth.test.ts` |
| Logs stored per API key | `backend/src/db.ts` | `backend.test.ts` (tenancy) |
| Real-time stream of requests | `backend/src/ws.ts`, `dashboard/src/lib/useLiveLogs.ts` | the screenshot above |
| Click through to full detail | `dashboard/src/routes/RequestDetail.tsx` | the screenshot below |
| Filter by method, status, URL substring | `dashboard/src/routes/Requests.tsx` | `backend.test.ts` (filters) |

Two URLs are recorded, not one. A proxy sits between two requests: `url` is what
the caller asked the gateway for — what the URL filter searches and what "copy as
cURL" reproduces — and `upstreamUrl` is where it was forwarded. Every upstream
shares the same paths, so without the second there is nothing to say whether a
call reached OpenAI or the local mock.

## The hard part

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

**Pull-driven, not a `TransformStream`.** `tee()` was the first instinct and it
is worse here: two consumers of one source means the stream runs at the speed of
the slower branch, and an unconsumed branch deadlocks it outright. A pull-driven
readable has one consumer, so back-pressure runs from the caller's socket to the
upstream connection — and `cancel` gives an explicit hook that `TransformStream`
does not, which is how a caller hanging up becomes `client_aborted` rather than
an anonymous stream error.

**`observe` is on the hot path, so it does almost nothing.** Reframe, parse,
append, stamp a timestamp. Record assembly happens after the last byte is on the
wire, and `LogSink.write` is synchronous and must never throw. A sink that blocks
for 300ms does not move the caller's per-chunk timings; a sink that throws does
not break the response. Both are asserted, because both are the actual claim.

Four things about SSE that are easy to get wrong:

- **A streamed failure is still `200 OK`.** The status is committed before the
  body exists, so a stream that dies at token 400 looks successful. The gateway
  derives its own verdict — `completed` / `client_aborted` / `upstream_error` /
  `truncated` — from whether `[DONE]` arrived, whether an error appeared in-band,
  and whether the caller left. Filtering on that answers a question status codes
  cannot.
- **Streams carry no token usage** unless the request sets
  `stream_options.include_usage`. Rather than log zeros on exactly the calls
  people most want to measure, the gateway adds the flag, reads the usage chunk,
  and strips that chunk again if the caller did not ask for it. The one place the
  proxy is not byte-transparent — disclosed here rather than buried, and
  `injectUsage: false` turns it off.
- **TCP does not respect message boundaries.** One read can hold half an event,
  three events, or a cut through a 4-byte emoji. `SseReframer` is the only
  component that has to know this.
- **A client that hangs up is still being billed.** The caller's `AbortSignal`
  goes to the upstream `fetch`. The test asserts the mock *stopped generating*,
  not merely that the gateway returned.

And one that cost a day. **A `pull` that enqueues nothing ends the stream.** A
`ReadableStream` schedules `pull` again when a chunk is enqueued, when a read
arrives, or when the stream closes — otherwise not at all. So a `pull` that reads
bytes, finds it is holding half an SSE frame, and resolves without enqueuing
*ends the pull chain permanently*: still `readable`, `desiredSize` still
positive, nothing failed, no further call ever comes.

Every test passed, and the first call to the real API hung after one token. It
was invisible against the mock, which wrote one whole frame per chunk. Against
`api.openai.com` a frame splits within the first few reads — a failure mode
*probabilistic in response length*, so a short smoke test passes and real traffic
hangs. `pull` now loops until it has something to hand over, the mock grew an
`x-mock-split-at` header so it can be as rude as a real socket, and
`streaming-frames.test.ts` hangs without the fix — verified by putting the bug
back. The lesson the whole test suite is built on: *a proxy is only tested by an
upstream that is allowed to be inconvenient.*

## Tradeoffs

| Decision | Why | What it costs |
|---|---|---|
| SQLite via built-in `node:sqlite` | `npm install && npm run dev`, no server, no container, no native build | single writer, single node; real volume wants ClickHouse or Timescale |
| Gateway and backend as separate processes | the proxy must not be slowed or taken down by the logging path | more moving parts than one process |
| Bounded in-memory queue for log shipping | no broker to install; back-pressure explicit, drops counted rather than silent | at-most-once on crash. Retries make delivery at-least-once, which `INSERT OR REPLACE` on the caller-supplied id turns back into effectively-once |
| Pull-driven readable over `tee()` | one consumer, real back-pressure, an explicit cancel hook | the observer runs on the hot path, so it must stay trivial |
| Inject `include_usage`, strip the chunk | exact token counts without changing what the caller sees | the proxy is no longer purely transparent |
| Full bodies stored, truncated at 256 KB | inspecting them is the entire point of the tool | prompts are user data; production needs retention limits, field-level redaction, encryption at rest |
| SHA-256 for keys, not bcrypt | 128+ bits of random checked on every request; a slow KDF adds latency and buys nothing against an unguessable secret | wrong choice entirely for human-chosen passwords |
| Header allowlists in both directions | a header nobody thought about leaks nothing | an unusual header needs an explicit addition |
| Plain CSS, no component library | a devtool is tables and chips; one stylesheet is less machinery than a design system | no theming story beyond CSS variables |

## Tenancy

`api_key_id` is the isolation boundary, enforced in one place rather than
sprinkled through the handlers. Note what is *missing* from the API: no endpoint
accepts an `api_key_id` parameter. The only way to say which logs you want is to
prove which key you hold, so there is no version of these handlers that can be
talked into crossing tenants. Fetching another key's record by id returns `404`,
not `403` — you cannot even learn it exists.

The WebSocket carries the key as a **subprotocol**, not a query parameter.
Browsers cannot set headers on a WS handshake, so `?key=…` is the usual shortcut
— and then the key is in access logs, proxy logs and browser history.

## The dashboard

![Request detail: both URLs, the request id, and headers with authorization redacted](docs/detail.png)

The gateway key *is* the login: whoever holds it owns the traffic made with it,
which is exactly the boundary the backend enforces.

- **Rows are buffered and flushed every 200ms.** Busy traffic arrives faster than
  React should re-render; one update per tick keeps the table readable.
- **Pause stops rows being prepended, not the socket.** An auto-scrolling table is
  unusable the moment you try to click a row in it, and the backlog is still
  there when you resume.
- **Filters are pushed to the server**, which applies the same predicate its SQL
  uses. A filtered view stays live without shipping rows the browser would
  discard — and without rows appearing that would vanish on refresh. That shared
  predicate has its own test. Filters live in the query string, so any view is a
  shareable link.
- **The time window travels as a duration, not a timestamp.** An anchored `since`
  would freeze "the last hour" at the moment the chip was clicked; sending
  `windowMs` lets the server resolve it against its own clock every query.
- **Two silences are named rather than left to interpretation.** A backend that
  went away and a queue that overflowed both look like "no traffic" in a live
  table. Each gets a banner saying which, because an inspector that quietly
  under-reports is worse than one that is obviously down.

## Verification

The interesting tests check the claim rather than the code.

Every mock chunk carries the timestamp it was emitted at, so `arrived - emitted`
is the gateway's transit cost for that chunk. Two shapes are possible: streaming
produces a small **flat** overhead across all chunks; buffering produces an
overhead equal to the whole generation time on chunk 0, decaying to zero on the
last. A flat line is the proof, and nothing else produces one.

| Test | What it proves |
|---|---|
| `streaming-timing` — flat overhead | per-chunk spread < 100ms where buffering would be ~440ms |
| `sink-isolation` — blocking sink | a sink blocking 300ms does not move caller timings; called exactly once |
| `sink-isolation` — throwing sink | a logging failure never becomes a caller-facing failure |
| `streaming-frames` — split frames | a frame split across reads still reaches the caller; hangs without the fix |
| `sse` — split multi-byte char | an emoji cut across two reads is not corrupted in the log |
| `logging` — in-band error | `terminal_state = upstream_error` on a `200 OK` stream |
| `logging` — client disconnect | the upstream stopped generating, not just the gateway |
| `logging` — redaction | neither the caller's key nor the upstream key appears in a stored record |
| `sink-http` — overflow | the oldest records are dropped, and the count reaches the dashboard |
| `backend` — tenancy | key A cannot list or fetch key B's logs; unknown key is 401 |
| `backend` — idempotent ingest | a retried batch does not duplicate rows |
| `backend` — live predicate | the WS filter agrees with the SQL filter |

Twelve of 89. The rest cover usage capture, both URLs, filters, keyset
pagination, time windows, config validation and cURL generation. Back-pressure is
deliberately *not* asserted end-to-end; the comment in `logging.test.ts` explains
why a test written against the mock would measure the mock's HTTP adapter rather
than the gateway, and what is asserted instead.

## Walk it yourself

Eight steps, about three minutes, no API key required.

**1–2. Start it and sign in.** `npm run dev`, then
**http://localhost:5173** with `gw_live_demo_key_1`. There is no username and no
password. Try a wrong key first — the error distinguishes "that key is invalid"
from "the backend is unreachable", because those need different reactions.

**3. Send a request.** `npm run ask -- "what is a FIFO buffer?"`

`examples/ask.mjs` is a real client: the official `openai` SDK with nothing
changed but `baseURL`. Tokens stream into your terminal as they arrive, and when
it finishes it fetches the gateway's own log row and compares:

```
what the caller saw                what the gateway recorded
  characters received   1857         characters logged     1857
  chunks with content    378         chunks                 380
  time to first token   1468ms       time to first token   1435ms
✓ the text the caller received is byte-identical to the text logged
```

That answers "how do I know the thing I am inspecting is the thing the caller
received?" — it is asserted, and the script exits non-zero if it fails.

**4–6. Watch, open, filter.** The row appears without a refresh, pushed over a
WebSocket — the dot beside the search box is the connection state. Click it, or
press `j` / `k`. Four tabs: **request** (the prompt as a conversation, not raw
JSON), **response**, **headers** (`authorization` shown as `[redacted]`),
**timing** (waiting vs. generating, TTFT, chunks, tokens). The header carries
both URLs and the request id — the same value returned in
`x-gateway-request-id` — and **copy as cURL** yields a runnable command. Filter
with chips for method, status class, outcome and model; free text matches the
URL; `15m / 1h / 24h / 7d` sets the window.

**7. Prove the tenancy boundary.** Send traffic as a second key, then sign in as
it: you see that request and none of the first key's.

```bash
GATEWAY_API_KEY=gw_live_demo_key_2 npm run ask -- "a question from another app"
```

Two applications, one gateway, one upstream key funding both, neither able to
read the other's prompts.

**8. Prove logging cannot take the proxy down.** Kill just the log backend, then
send another request — the answer still streams.

```bash
lsof -ti:4020 | xargs kill -9
npm run ask -- "does the gateway still work?"
```

The dashboard says it is offline in words rather than going quietly still, and
reconnects on its own. If the queue overflows while it is away, it reports how
many records were lost — silent log loss is the failure mode of every buffered
logging system, and this one is not silent.

## Layout

```
packages/
  shared/        LogRecord + view types (the contract) and key hashing
  mock-openai/   metronome upstream: timestamped SSE, controllable failures
  gateway/       the proxy
    src/sse.ts       reframes bytes into whole SSE events
    src/capture.ts   accumulates the log record as events fly past
    src/sink.ts      LogSink interface + memory and HTTP implementations
    src/app.ts       the proxy itself
  backend/       ingest, SQLite store, query API, WebSocket fan-out
  dashboard/     React + Vite
    src/routes/      Login, Requests (live table + filters), RequestDetail, Keys
    src/lib/         API client, the live feed hook, formatting
examples/
  ask.mjs        a real client: streams an answer, then checks it against the log
```

## Scaling

The proxy tier scales by buying machines — it is stateless already. The logging
plane does not, in its current shape: one stored record per request is 4 GB/s and
345 TB/day at a million requests per second, and no choice of database fixes
that. The answer is to split metrics (aggregated, every request, forever) from
traces (sampled, full fidelity, short retention), worth roughly 100x before any
infrastructure changes.

Two findings from working that through are already fixed here, because they were
cheap and real. **The first ceiling was 200 records/sec** — one batch of 50 every
250ms, one request in flight; the sink now runs several batches concurrently,
since the limit is round-trip latency rather than bytes, and a test asserts the
concurrency rather than trusting the constant. **Batch inserts now run in one
transaction**, where each row was previously its own implicit transaction and its
own WAL commit.

## Further work

Per-key rate limits and budgets; provider fan-out behind one OpenAI-shaped API;
response caching; session/trace grouping so a whole agent run reads as one tree
instead of forty loose rows; PII scrubbing before storage; OpenTelemetry export;
a retention policy, because storing full prompts forever is a liability.

Rejected keys are not logged: the auth check returns before the log emitter is
constructed, so a `401` leaves no row. "Someone is trying keys against my
gateway" is precisely what an inspector should surface, and it is a small fix —
move the check below `emit` and write a row with a null `apiKeyId`.

## AI assistance

_(Describe here how Copilot / Claude / ChatGPT were used — the brief asks, and a
straight answer reads better than a vague one.)_
