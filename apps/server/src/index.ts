import { serve } from '@hono/node-server';
import { CanvasClient } from '@planner/canvas';
import { createApp } from './app';
import { CanvasIcsSource } from './canvas/canvas-ics-source';
import { CanvasSource } from './canvas/canvas-source';
import { createDb } from './db/client';
import { loadEnv } from './env';
import { GoogleCalendarClient } from './google/calendar-client';
import { GoogleCalendarSource } from './google/calendar-source';
import { GoogleAuth } from './google/oauth';
import { GoogleTasksClient } from './google/tasks-client';
import { createInbound } from './inbound/setup';
import { log } from './log';
import type { CalendarWriter } from './routes/calendar';
import { createTokenStore } from './secrets/token-store';
import { SyncScheduler } from './sync/scheduler';
import type { SyncSource } from './sync/types';

const env = loadEnv();
const db = createDb(env.DATABASE_PATH);
const sources: SyncSource[] = [];
let calendar: CalendarWriter | undefined;
let googleTasks: GoogleTasksClient | undefined;

if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  const store = await createTokenStore(env);
  const auth = new GoogleAuth(
    { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    store,
  );
  const client = new GoogleCalendarClient(auth);
  sources.push(
    new GoogleCalendarSource(client, {
      calendarIds: env.GOOGLE_CALENDAR_IDS,
      appTimeZone: env.APP_TIMEZONE,
      intervalMs: env.GOOGLE_SYNC_INTERVAL_MINUTES * 60_000,
      lookbackDays: env.GOOGLE_SYNC_LOOKBACK_DAYS,
    }),
  );
  googleTasks = new GoogleTasksClient(auth);
  calendar = {
    client,
    defaultCalendarId: env.GOOGLE_CALENDAR_IDS[0] ?? 'primary',
    appTimeZone: env.APP_TIMEZONE,
  };
  log.info('google calendar enabled', { tokenStore: store.kind });
} else {
  log.info('google calendar disabled (GOOGLE_CLIENT_ID/SECRET not set)');
}

if (env.CANVAS_BASE_URL && env.CANVAS_TOKEN) {
  const client = new CanvasClient({ baseUrl: env.CANVAS_BASE_URL, token: env.CANVAS_TOKEN });
  sources.push(
    new CanvasSource(client, {
      baseUrl: env.CANVAS_BASE_URL,
      appTimeZone: env.APP_TIMEZONE,
      intervalMs: env.CANVAS_SYNC_INTERVAL_MINUTES * 60_000,
      lookbackDays: env.CANVAS_LOOKBACK_DAYS,
      lookaheadDays: env.CANVAS_LOOKAHEAD_DAYS,
      includeGrades: env.CANVAS_SYNC_GRADES,
    }),
  );
  log.info('canvas enabled', { mode: 'rest' });
} else if (env.CANVAS_ICS_URL) {
  sources.push(
    new CanvasIcsSource({
      feedUrl: env.CANVAS_ICS_URL,
      appTimeZone: env.APP_TIMEZONE,
      intervalMs: env.CANVAS_SYNC_INTERVAL_MINUTES * 60_000,
    }),
  );
  log.info('canvas enabled', { mode: 'ics' });
}

const now = () => new Date();
const scheduler = new SyncScheduler(db, sources);
const inbound = createInbound(env, {
  db,
  now,
  calendar: calendar && { client: calendar.client, calendarId: calendar.defaultCalendarId },
  tasks: googleTasks,
});
const app = createApp({
  db,
  scheduler,
  now,
  calendar,
  inbound: inbound ? { pipeline: inbound.pipeline, channels: inbound.channels } : undefined,
});

scheduler.start();
inbound?.poller?.start();
serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info('server listening', { port: info.port, env: env.NODE_ENV, sources: sources.length });
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    scheduler.stop();
    inbound?.poller?.stop();
    process.exit(0);
  });
}
