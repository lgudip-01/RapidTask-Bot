import type { HelloResponse } from '@planner/shared';
import { Hono } from 'hono';
import type { Db } from './db/client';
import { log, sanitizeError } from './log';
import { agendaRoutes } from './routes/agenda';
import { syncRoutes } from './routes/sync';
import { calendarRoutes, type CalendarWriter } from './routes/calendar';
import { canvasRoutes } from './routes/canvas';
import { taskRoutes } from './routes/tasks';
import { webhookRoutes } from './routes/webhooks';
import type { InboundPipeline } from './inbound/pipeline';
import type { InboundChannel } from './inbound/types';
import type { SyncScheduler } from './sync/scheduler';

export interface AppDeps {
  db: Db;
  scheduler: SyncScheduler;
  now: () => Date;
  /** Present when Google is configured; calendar write routes answer 503 otherwise. */
  calendar?: CalendarWriter;
  /** Present when at least one messaging channel is configured. */
  inbound?: {
    pipeline: InboundPipeline;
    channels: Partial<Record<'telegram' | 'twilio', InboundChannel>>;
  };
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
  app.route('/api/calendar', calendarRoutes(deps));
  app.route('/api', canvasRoutes(deps));
  app.route('/webhooks', webhookRoutes(deps));

  return app;
}
