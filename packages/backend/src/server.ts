import { serve } from '@hono/node-server';
import { parseKeySpec } from '@gw/shared/keys';
import { assertConfigured, requiredInProduction } from '@gw/shared/env';
import { createBackend } from './app.ts';
import { LogStore } from './db.ts';
import { Hub, attachWebSocket } from './ws.ts';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env is fine.
}

const DEFAULT_KEYS = 'demo-app:gw_live_demo_key_1,agent-runner:gw_live_demo_key_2';

// Both services must agree on the same key list, so both check the same two
// variables the same way. See shared/src/env.ts.
const missing: string[] = [];
const keySpec = requiredInProduction('GATEWAY_API_KEYS', DEFAULT_KEYS, missing);
const ingestSecret = requiredInProduction('INGEST_SECRET', 'dev-secret', missing);
assertConfigured(missing);

const port = Number(process.env.PORT ?? process.env.BACKEND_PORT ?? 4020);
const keys = parseKeySpec(keySpec);
const store = new LogStore(process.env.DB_PATH ?? 'gateway.db');
const hub = new Hub();

const app = createBackend({
  store,
  hub,
  keys,
  ingestSecret,
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
