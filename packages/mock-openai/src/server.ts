import { serve } from '@hono/node-server';
import { app } from './app.ts';

const port = Number(process.env.MOCK_PORT ?? 4010);

serve({ fetch: app.fetch, port }, () => {
  console.log(`mock OpenAI upstream listening on http://localhost:${port}`);
});
