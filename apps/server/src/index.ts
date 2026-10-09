import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createDb } from './db/client';
import { loadEnv } from './env';
import { GoogleCalendarClient } from './google/calendar-client';
import { GoogleCalendarSource } from './google/calendar-source';
import { GoogleAuth } from './google/oauth';
import { log } from './log';
import type { CalendarWriter } from './routes/calendar';
import { createTokenStore } from './secrets/token-store';
import { SyncScheduler } from './sync/scheduler';
import type { SyncSource } from './sync/types';

const env = loadEnv();
const db = createDb(env.DATABASE_PATH);
const sources: SyncSource[] = [];
let calendar: CalendarWriter | undefined;

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
  calendar = {
    client,
    defaultCalendarId: env.GOOGLE_CALENDAR_IDS[0] ?? 'primary',
    appTimeZone: env.APP_TIMEZONE,
  };
  log.info('google calendar enabled', { tokenStore: store.kind });
} else {
  log.info('google calendar disabled (GOOGLE_CLIENT_ID/SECRET not set)');
}

const scheduler = new SyncScheduler(db, sources);
const app = createApp({ db, scheduler, now: () => new Date(), calendar });

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
