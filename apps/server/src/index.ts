import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createDb } from './db/client';
import { loadEnv } from './env';
import { log } from './log';
import { SyncScheduler } from './sync/scheduler';
import type { SyncSource } from './sync/types';

const env = loadEnv();
const db = createDb(env.DATABASE_PATH);
// Real sources (Google Calendar, Canvas, …) are registered here as they are implemented.
const sources: SyncSource[] = [];
const scheduler = new SyncScheduler(db, sources);
const app = createApp({ db, scheduler, now: () => new Date() });

scheduler.start();
serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info('server listening', { port: info.port, env: env.NODE_ENV, sources: sources.length });
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    scheduler.stop();
    process.exit(0);
  });
}
