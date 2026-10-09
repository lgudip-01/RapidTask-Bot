import type { HelloResponse } from '@planner/shared';
import { Hono } from 'hono';
import type { Db } from './db/client';
import { log, sanitizeError } from './log';
import { agendaRoutes } from './routes/agenda';
import { syncRoutes } from './routes/sync';
import { taskRoutes } from './routes/tasks';
import type { SyncScheduler } from './sync/scheduler';

export interface AppDeps {
  db: Db;
  scheduler: SyncScheduler;
  now: () => Date;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.onError((err, c) => {
    log.error('unhandled', { path: c.req.path, error: sanitizeError(err) });
    return c.json({ error: 'internal_error' }, 500);
  });

  app.get('/api/hello', (c) =>
    c.json<HelloResponse>({ message: 'Hello from Planner', time: deps.now().toISOString() }),
  );
  app.route('/api/agenda', agendaRoutes(deps));
  app.route('/api/tasks', taskRoutes(deps));
  app.route('/api/sync', syncRoutes(deps));

  return app;
}
