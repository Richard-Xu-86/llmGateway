import { Hono } from 'hono';
import { IngestBatch } from '@gw/shared';
import { authenticate, type ApiKey } from '@gw/shared/keys';
import type { Filters, LogStore } from './db.ts';
import type { Hub } from './ws.ts';

export interface BackendConfig {
  store: LogStore;
  hub: Hub;
  keys: ApiKey[];
  ingestSecret: string;
}

const list = (value: string | undefined): string[] | undefined =>
  value ? value.split(',').map((v) => v.trim()).filter(Boolean) : undefined;

export function createBackend({ store, hub, keys, ingestSecret }: BackendConfig) {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true, subscribers: hub.size }));

  /**
   * Internal. The gateway ships batches here off its response path.
   * Shared-secret rather than a gateway key: this is service-to-service, and it
   * must not be possible to write logs by holding a *caller's* key.
   */
  app.post('/ingest', async (c) => {
    if (c.req.header('x-ingest-secret') !== ingestSecret) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const parsed = IngestBatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'malformed batch' }, 400);

    store.insert(parsed.data.records);
    for (const record of parsed.data.records) hub.broadcast(record);

    return c.json({ accepted: parsed.data.records.length });
  });

  /**
   * Everything below is scoped to the key that was presented.
   *
   * Note what is missing: no endpoint accepts an api_key_id parameter. The only
   * way to say which logs you want is to prove which key you hold, so there is
   * no version of these handlers that can be talked into crossing tenants.
   */
  app.use('/api/*', async (c, next) => {
    const key = authenticate(keys, c.req.header('authorization'));
    if (!key) return c.json({ error: 'invalid gateway API key' }, 401);
    c.set('key' as never, key as never);
    await next();
  });

  const keyOf = (c: any): ApiKey => c.get('key');

  app.get('/api/me', (c) => {
    const key = keyOf(c);
    return c.json({ name: key.name, last4: key.last4 });
  });

  app.get('/api/logs', (c) => {
    const q = c.req.query();
    const filters: Filters = {
      methods: list(q.methods),
      statusClasses: list(q.status),
      terminalStates: list(q.states),
      models: list(q.models),
      q: q.q || undefined,
    };
    const limit = Math.min(Number(q.limit) || 50, 200);
    return c.json(store.query(keyOf(c).id, filters, q.cursor ?? null, limit));
  });

  app.get('/api/logs/:id', (c) => {
    const record = store.get(keyOf(c).id, c.req.param('id'));
    return record ? c.json(record) : c.json({ error: 'not found' }, 404);
  });

  app.get('/api/stats', (c) => {
    const windowMs = Number(c.req.query('windowMs')) || 60 * 60 * 1000;
    return c.json(store.stats(keyOf(c).id, Date.now() - windowMs));
  });

  app.get('/api/models', (c) => c.json({ models: store.models(keyOf(c).id) }));

  return app;
}
