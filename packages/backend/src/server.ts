import { serve } from '@hono/node-server';
import { parseKeySpec } from '@gw/shared/keys';
import { createBackend } from './app.ts';
import { LogStore } from './db.ts';
import { Hub, attachWebSocket } from './ws.ts';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env is fine.
}

const DEFAULT_KEYS = 'demo-app:gw_live_demo_key_1,agent-runner:gw_live_demo_key_2';

const port = Number(process.env.BACKEND_PORT ?? 4020);
const keys = parseKeySpec(process.env.GATEWAY_API_KEYS ?? DEFAULT_KEYS);
const store = new LogStore(process.env.DB_PATH ?? 'gateway.db');
const hub = new Hub();

const app = createBackend({
  store,
  hub,
  keys,
  ingestSecret: process.env.INGEST_SECRET ?? 'dev-secret',
});

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`backend listening on http://localhost:${port}`);
  console.log(`  db   : ${process.env.DB_PATH ?? 'gateway.db'}`);
  console.log(`  ws   : ws://localhost:${port}/api/stream`);
});

attachWebSocket(server as never, keys, hub);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    store.close();
    process.exit(0);
  });
}
