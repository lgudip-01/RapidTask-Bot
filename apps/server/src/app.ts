import type { HelloResponse } from '@planner/shared';
import { Hono } from 'hono';

export function createApp() {
  const app = new Hono();

  app.get('/api/hello', (c) =>
    c.json<HelloResponse>({ message: 'Hello from Planner', time: new Date().toISOString() }),
  );

  return app;
}
