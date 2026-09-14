import { serve } from '@hono/node-server';
import { createGateway } from './app.ts';
import { parseKeySpec } from '@gw/shared/keys';
import { assertConfigured, requiredInProduction } from '@gw/shared/env';
import { HttpSink, MemorySink, type LogSink } from './sink.ts';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env is fine in development — every value below has a working default.
}

const DEFAULT_KEYS = 'demo-app:gw_live_demo_key_1,agent-runner:gw_live_demo_key_2';

// Collected rather than thrown one at a time, so a deploy surfaces every
// missing variable at once. See shared/src/env.ts for why these two in
// particular refuse to fall back in production.
const missing: string[] = [];
const keySpec = requiredInProduction('GATEWAY_API_KEYS', DEFAULT_KEYS, missing);
const ingestSecret = requiredInProduction('INGEST_SECRET', 'dev-secret', missing);
assertConfigured(missing);

const port = Number(process.env.PORT ?? process.env.GATEWAY_PORT ?? 4000);
const upstreamBaseUrl = process.env.UPSTREAM_BASE_URL ?? 'http://localhost:4010';
const keys = parseKeySpec(keySpec);

const sink: LogSink =
  process.env.LOG_SINK === 'http'
    ? new HttpSink({
        url: process.env.BACKEND_INGEST_URL ?? 'http://localhost:4020/ingest',
        secret: ingestSecret,
      })
    : new MemorySink();

const app = createGateway({
  upstreamBaseUrl,
  upstreamApiKey: process.env.OPENAI_API_KEY ?? 'mock-key-not-used-by-the-mock-upstream',
  keys,
  sink,
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`gateway listening on http://localhost:${port}`);
  console.log(`  upstream : ${upstreamBaseUrl}`);
  console.log(`  log sink : ${process.env.LOG_SINK === 'http' ? 'http -> backend' : 'memory'}`);
  console.log(`  keys     : ${keys.map((k) => `${k.name} (…${k.last4})`).join(', ')}`);
  if (!process.env.GATEWAY_API_KEYS) {
    console.log('\n  try it:');
    console.log(
      `    curl -N http://localhost:${port}/v1/chat/completions \\\n` +
        '      -H "Authorization: Bearer gw_live_demo_key_1" \\\n' +
        '      -H "Content-Type: application/json" \\\n' +
        '      -d \'{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"hi"}]}\'\n',
    );
  }
});

/**
 * Registering a handler replaces Node's default behaviour of exiting, so this
 * has to exit for itself — on every path.
 *
 * It did not. `sink.close?.().finally(…)` short-circuits the *whole* chain when
 * `close` is undefined, which it is on `MemorySink`. So with LOG_SINK unset the
 * gateway caught SIGTERM, did nothing, and kept port 4000 — surviving both
 * Ctrl-C and `scripts/dev.mjs` shutting down. The next `npm run dev` then died
 * with EADDRINUSE against a server that was still happily serving old code.
 *
 * `Promise.resolve` makes the absent case a resolved promise rather than the
 * end of the chain. The timeout is belt and braces: a sink that hangs on flush
 * must not be able to keep the port either.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    const forced = setTimeout(() => process.exit(0), 2000);
    forced.unref();
    void Promise.resolve(sink.close?.()).finally(() => process.exit(0));
  });
}
