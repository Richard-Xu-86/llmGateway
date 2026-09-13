import { serve } from '@hono/node-server';
import { app as mockApp } from '../../mock-openai/src/app.ts';
import { createGateway } from '../src/app.ts';
import { parseKeySpec } from '../src/auth.ts';
import { MemorySink, type LogSink } from '../src/sink.ts';
import { SseReframer, parseEventData } from '../src/sse.ts';

export const TEST_KEY = 'gw_test_key_alpha';
export const OTHER_KEY = 'gw_test_key_beta';
export const UPSTREAM_SECRET = 'sk-test-upstream-secret-do-not-log';

function listen(fetchFn: (req: Request) => Response | Promise<Response>) {
  return new Promise<{ url: string; server: { close: (cb?: () => void) => void } }>((resolve) => {
    const server = serve({ fetch: fetchFn, port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({ url: `http://127.0.0.1:${info.port}`, server: server as never });
    });
  });
}

export async function startStack<S extends LogSink = MemorySink>(
  opts: { sink?: S; injectUsage?: boolean } = {},
) {
  const mock = await listen(mockApp.fetch);
  const sink = (opts.sink ?? new MemorySink()) as S;

  const gatewayApp = createGateway({
    upstreamBaseUrl: mock.url,
    upstreamApiKey: UPSTREAM_SECRET,
    keys: parseKeySpec(`demo-app:${TEST_KEY},other-app:${OTHER_KEY}`),
    sink,
    injectUsage: opts.injectUsage,
  });
  const gateway = await listen(gatewayApp.fetch);

  return {
    gatewayUrl: gateway.url,
    mockUrl: mock.url,
    sink,
    async mockStats(id: string) {
      const res = await fetch(`${mock.url}/__mock/stats/${id}`);
      return res.ok ? ((await res.json()) as Record<string, number | boolean>) : null;
    },
    async close() {
      // A test that deliberately leaves a stream hanging would otherwise keep
      // the server's keep-alive sockets open and stall close().
      for (const s of [gateway.server, mock.server] as Array<{
        closeAllConnections?: () => void;
      }>) {
        s.closeAllConnections?.();
      }
      await new Promise<void>((r) => gateway.server.close(() => r()));
      await new Promise<void>((r) => mock.server.close(() => r()));
    },
  };
}

export interface ChatOptions {
  key?: string;
  /** becomes x-mock-<name> headers, e.g. { chunks: 12, 'gap-ms': 40 } */
  mock?: Record<string, string | number>;
  /** merged into the JSON request body */
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}

export function postChat(gatewayUrl: string, opts: ChatOptions = {}) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.key ?? TEST_KEY}`,
    'content-type': 'application/json',
  };
  for (const [name, value] of Object.entries(opts.mock ?? {})) {
    headers[`x-mock-${name}`] = String(value);
  }
  return fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      ...opts.body,
    }),
    signal: opts.signal,
  });
}

export interface SseEvent {
  raw: string;
  data: string | null;
  json: any;
  /** when this event was handed to the test, ms since epoch */
  arrivedAt: number;
}

/** Reads a live SSE response the way a real client would, one event at a time. */
export async function* readEvents(res: Response): AsyncGenerator<SseEvent> {
  const reframer = new SseReframer();
  const reader = res.body!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const raw of reframer.push(value)) {
      const data = parseEventData(raw);
      let json: any;
      if (data && data !== '[DONE]') {
        try {
          json = JSON.parse(data);
        } catch {
          json = undefined;
        }
      }
      yield { raw, data, json, arrivedAt: Date.now() };
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForLog(sink: LogSink, id: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (sink as MemorySink).byId(id);
    if (found) return found;
    await sleep(10);
  }
  throw new Error(`no log record for request ${id} within ${timeoutMs}ms`);
}
