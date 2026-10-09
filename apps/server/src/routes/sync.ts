import type { SyncStatus } from '@planner/shared';
import { Hono } from 'hono';
import type { AppDeps } from '../app';
import { AlreadyRunningError, UnknownSourceError } from '../sync/scheduler';

export function syncRoutes({ scheduler }: AppDeps) {
  return new Hono()
    .get('/status', (c) => c.json<{ sources: SyncStatus[] }>({ sources: scheduler.status() }))
    .post('/:source/run', async (c) => {
      const name = c.req.param('source');
      try {
        return c.json(await scheduler.run(name));
      } catch (e) {
        if (e instanceof UnknownSourceError) return c.json({ error: 'unknown_source' }, 404);
        if (e instanceof AlreadyRunningError) return c.json({ error: 'already_running' }, 409);
        throw e;
      }
    });
}
