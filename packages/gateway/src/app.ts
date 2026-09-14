import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { type LogRecord, redactHeaders, truncateBody } from '@gw/shared';
import { type ApiKey, authenticate } from '@gw/shared/keys';
import { StreamCapture } from './capture.ts';
import { SseReframer } from './sse.ts';
import type { LogSink } from './sink.ts';

export interface GatewayConfig {
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  keys: ApiKey[];
  sink: LogSink;
  /**
   * Streamed responses carry no token usage unless the request opts in. When
   * true the gateway adds `stream_options.include_usage`, reads the usage
   * chunk, and removes that chunk again if the caller did not ask for it — so
   * usage is exact and the caller's stream is unchanged.
   *
   * This is the one place the proxy is not byte-transparent. Set false to
   * disable and log usage as unknown for streams.
   */
  injectUsage?: boolean;
}

/** Client -> upstream. Allowlist, not denylist: a forgotten header should leak nothing. */
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'openai-beta', 'user-agent'];

/** Upstream -> client. content-length / content-encoding are deliberately absent. */
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'openai-model',
  'openai-organization',
  'openai-processing-ms',
  'openai-version',
  'x-request-id',
  'retry-after',
];

const once = <T extends (...args: never[]) => void>(fn: T): T => {
  let called = false;
  return ((...args: never[]) => {
    if (called) return;
    called = true;
    fn(...args);
  }) as T;
};

export function createGateway(config: GatewayConfig) {
  const injectUsageEnabled = config.injectUsage ?? true;
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true, upstream: config.upstreamBaseUrl }));

  app.all('/v1/*', async (c) => {
    const startedAt = Date.now();
    const id = randomUUID();

    const key = authenticate(config.keys, c.req.header('authorization'));
    if (!key) {
      return c.json(
        {
          error: {
            message: 'Missing or invalid gateway API key. Send it as: Authorization: Bearer <key>',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
        401,
      );
    }

    const method = c.req.method;
    const requestUrl = new URL(c.req.url);
    const rawBody = method === 'GET' || method === 'HEAD' ? '' : await c.req.text();

    let parsedBody: any;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      parsedBody = undefined;
    }

    const isStream = parsedBody?.stream === true;
    const callerWantsUsage = parsedBody?.stream_options?.include_usage === true;
    const injectUsage = isStream && !callerWantsUsage && injectUsageEnabled;

    let outboundBody = rawBody;
    if (injectUsage) {
      outboundBody = JSON.stringify({
        ...parsedBody,
        stream_options: { ...(parsedBody.stream_options ?? {}), include_usage: true },
      });
    }

    const upstreamHeaders = new Headers();
    for (const [name, value] of Object.entries(c.req.header())) {
      const lower = name.toLowerCase();
      // x-mock-* lets tests drive the mock upstream *through* the gateway.
      if (FORWARD_REQUEST_HEADERS.includes(lower) || lower.startsWith('x-mock-')) {
        upstreamHeaders.set(lower, value);
      }
    }
    upstreamHeaders.set('authorization', `Bearer ${config.upstreamApiKey}`);
    // Never negotiate compression: a gzipped SSE stream is a buffered SSE stream.
    upstreamHeaders.set('accept-encoding', 'identity');

    const upstreamUrl =
      config.upstreamBaseUrl.replace(/\/$/, '') + requestUrl.pathname + requestUrl.search;

    const base = {
      id,
      apiKeyId: key.id,
      apiKeyName: key.name,
      startedAt,
      method,
      // The intercepted request is the one the caller made, so that is `url`.
      // Where it was forwarded is a separate, equally useful fact.
      url: c.req.url,
      upstreamUrl,
      path: requestUrl.pathname,
      model: typeof parsedBody?.model === 'string' ? parsedBody.model : null,
      isStream,
      requestHeaders: redactHeaders(c.req.header()),
      ...(({ body, truncated }) => ({ requestBody: body, requestBodyTruncated: truncated }))(
        truncateBody(rawBody || null),
      ),
    };

    const emit = (record: LogRecord) => {
      try {
        config.sink.write(record);
      } catch {
        // A logging failure must never become a caller-facing failure.
      }
    };

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method,
        headers: upstreamHeaders,
        body: method === 'GET' || method === 'HEAD' ? undefined : outboundBody,
        // Propagating the caller's abort signal is what stops the meter running
        // upstream when the caller hangs up mid-stream.
        signal: c.req.raw.signal,
      });
    } catch (err) {
      const aborted = c.req.raw.signal?.aborted === true;
      emit({
        ...base,
        status: 0,
        responseHeaders: {},
        responseBody: null,
        responseBodyTruncated: false,
        durationMs: Date.now() - startedAt,
        ttftMs: null,
        chunkCount: null,
        promptTokens: null,
        completionTokens: null,
        terminalState: aborted ? 'client_aborted' : 'upstream_error',
        finishReason: null,
        error: String(err instanceof Error ? err.message : err),
      });
      if (aborted) return new Response(null, { status: 499 });
      return c.json(
        { error: { message: `Upstream request failed: ${String(err)}`, type: 'api_error' } },
        502,
      );
    }

    const responseHeaders = new Headers();
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    // So a caller can paste an id from their own logs straight into the dashboard.
    responseHeaders.set('x-gateway-request-id', id);

    const contentType = upstream.headers.get('content-type') ?? '';
    const streaming = contentType.includes('text/event-stream') && upstream.body !== null;

    if (!streaming) {
      const text = await upstream.text();
      let usage: any;
      try {
        usage = JSON.parse(text)?.usage;
      } catch {
        usage = undefined;
      }
      const stored = truncateBody(text);
      emit({
        ...base,
        status: upstream.status,
        responseHeaders: redactHeaders(upstream.headers),
        responseBody: stored.body,
        responseBodyTruncated: stored.truncated,
        durationMs: Date.now() - startedAt,
        ttftMs: null,
        chunkCount: null,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        terminalState: upstream.ok ? 'completed' : 'upstream_error',
        finishReason: null,
        error: upstream.ok ? null : `upstream returned ${upstream.status}`,
      });
      return new Response(text, { status: upstream.status, headers: responseHeaders });
    }

    const capture = new StreamCapture(startedAt);
    const reframer = new SseReframer();
    const encoder = new TextEncoder();

    const finish = once(() => {
      const stored = truncateBody(capture.text);
      emit({
        ...base,
        model: capture.model ?? base.model,
        status: upstream.status,
        responseHeaders: redactHeaders(upstream.headers),
        responseBody: stored.body,
        responseBodyTruncated: stored.truncated,
        durationMs: Date.now() - startedAt,
        ttftMs: capture.ttftMs,
        chunkCount: capture.chunkCount,
        promptTokens: capture.promptTokens,
        completionTokens: capture.completionTokens,
        terminalState: capture.terminalState(),
        finishReason: capture.finishReason,
        error: capture.error(),
      });
    });

    const reader = upstream.body!.getReader();

    /**
     * GATEWAY_DEBUG_STREAM=1 traces the read loop to stderr, one line per read.
     * A stalled stream is otherwise invisible: nothing throws, nothing logs, and
     * the caller just sits there. This says which side stopped — no more reads
     * means upstream went quiet, reads with no events means we are mid-event,
     * and reads that forward nothing means we are dropping them.
     */
    const trace = process.env.GATEWAY_DEBUG_STREAM === '1';
    const short = id.slice(0, 8);
    let readCount = 0;
    let pullCount = 0;
    let forwarded = 0;
    let lastActivityAt = Date.now();
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    if (trace) {
      console.error(`[stream ${short}] open  status=${upstream.status} ct=${contentType}`);
      // A stalled stream produces no output at all, which makes "stopped" and
      // "still running but quiet" look identical. The heartbeat separates them:
      // if these lines keep printing, the process is alive and the stream went
      // quiet; if they stop too, the process itself is wedged.
      heartbeat = setInterval(() => {
        const secs = (ms: number) => (ms / 1000).toFixed(1);
        console.error(
          `[stream ${short}] · alive t+${secs(Date.now() - startedAt)}s ` +
            `pulls=${pullCount} reads=${readCount} fwd=${forwarded} ` +
            `idle=${secs(Date.now() - lastActivityAt)}s ` +
            `aborted=${c.req.raw.signal?.aborted === true}`,
        );
      }, 2000);
      heartbeat.unref?.();
    }
    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
    };

    /**
     * Pull-driven on purpose.
     *
     * `pull` is only called when the caller has room for more, so back-pressure
     * runs all the way from the caller's socket to the upstream connection —
     * a slow reader slows the source instead of filling a buffer here.
     *
     * `cancel` is the hook a TransformStream does not give you: when the caller
     * hangs up we learn about it directly, cancel the upstream body (stopping
     * the meter), and record it as an abort rather than a mystery error.
     */
    const out = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          /**
           * The loop is load-bearing, and the reason is a sharp edge in the
           * Streams spec: `pull` is scheduled again only when a chunk is
           * enqueued, when a fresh read arrives, or when the stream closes.
           * A `pull` that reads bytes, enqueues nothing and resolves therefore
           * ends the pull chain, and the stream hangs with no error anywhere.
           *
           * Two ordinary things make a read produce no event: a TCP read that
           * lands in the middle of an SSE event (the reframer holds a partial),
           * and the usage chunk we asked for on the caller's behalf and strip
           * again. So: keep reading until we have something to hand over.
           *
           * This is invisible against the mock, which emits one whole event per
           * write. It showed up on the first real API call. See the
           * split-frame test in test/streaming-frames.test.ts.
           */
          for (;;) {
            // Logged BEFORE the await: `pull enter` with no matching `read`
            // means the upstream read is hanging; no `pull enter` at all means
            // the stream stopped asking us for data.
            if (trace) {
              pullCount += 1;
              lastActivityAt = Date.now();
              console.error(`[stream ${short}] pull enter (read#${readCount + 1} pending)`);
            }
            const { done, value } = await reader.read();
            if (trace) {
              readCount += 1;
              lastActivityAt = Date.now();
              console.error(
                `[stream ${short}] read#${readCount} ${done ? 'DONE' : `${value!.byteLength}B`}`,
              );
            }
            if (done) {
              for (const event of reframer.end()) {
                if (capture.observe(event, injectUsage)) controller.enqueue(encoder.encode(event));
              }
              controller.close();
              if (trace) console.error(`[stream ${short}] closed after ${forwarded} events`);
              stopHeartbeat();
              finish(); // the caller already has every byte by now
              return;
            }
            // Hot path. Reframe, observe, forward. Nothing else.
            const events = reframer.push(value);
            let enqueued = 0;
            for (const event of events) {
              if (capture.observe(event, injectUsage)) {
                controller.enqueue(encoder.encode(event));
                forwarded += 1;
                enqueued += 1;
              }
            }
            if (trace) {
              console.error(
                `[stream ${short}]   ${events.length} events, ${enqueued} enqueued, ${forwarded} forwarded total, desiredSize=${controller.desiredSize}`,
              );
            }
            // Handed something over, so the consumer will ask again when ready.
            // Nothing to hand over means read again rather than resolve, or the
            // stream stops pulling for good.
            if (enqueued > 0) return;
          }
        } catch (err) {
          if (trace) console.error(`[stream ${short}] read threw: ${String(err)}`);
          if (c.req.raw.signal?.aborted) capture.aborted = true;
          else capture.transportError = String(err instanceof Error ? err.message : err);
          controller.error(err);
          stopHeartbeat();
          finish();
        }
      },
      cancel(reason) {
        if (trace) console.error(`[stream ${short}] cancel: ${String(reason)}`);
        capture.aborted = true;
        void reader.cancel(reason).catch(() => {});
        stopHeartbeat();
        finish();
      },
    });

    c.req.raw.signal?.addEventListener('abort', () => {
      if (trace) console.error(`[stream ${short}] caller signal aborted`);
      capture.aborted = true;
      void reader.cancel('client aborted').catch(() => {});
      stopHeartbeat();
      finish();
    });

    responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
    responseHeaders.set('cache-control', 'no-cache');
    // Tells nginx and friends not to undo everything above.
    responseHeaders.set('x-accel-buffering', 'no');
    //
    // Deliberately NOT setting `connection: keep-alive`. It is a hop-by-hop
    // header describing one TCP link, so a proxy must never set or forward it
    // (RFC 9110 7.6.1) - and setting it by hand makes Node stop managing the
    // response framing itself, so the chunked terminator can go unwritten. curl
    // tolerates a body that simply stops; a strict SSE parser reports
    // "Premature close". Let the runtime own its own framing.

    return new Response(out, { status: upstream.status, headers: responseHeaders });
  });

  return app;
}
