import { serve } from '@hono/node-server';
import { createGateway } from './app.ts';
import { parseKeySpec } from './auth.ts';
import { HttpSink, MemorySink, type LogSink } from './sink.ts';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env is fine — every value below has a working default.
}

const DEFAULT_KEYS = 'demo-app:gw_live_demo_key_1,agent-runner:gw_live_demo_key_2';

const port = Number(process.env.GATEWAY_PORT ?? 4000);
const upstreamBaseUrl = process.env.UPSTREAM_BASE_URL ?? 'http://localhost:4010';
const keys = parseKeySpec(process.env.GATEWAY_API_KEYS ?? DEFAULT_KEYS);

const sink: LogSink =
  process.env.LOG_SINK === 'http'
    ? new HttpSink({
        url: process.env.BACKEND_INGEST_URL ?? 'http://localhost:4020/ingest',
        secret: process.env.INGEST_SECRET ?? 'dev-secret',
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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void sink.close?.().finally(() => process.exit(0));
  });
}
