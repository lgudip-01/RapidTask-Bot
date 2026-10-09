import { serve } from '@hono/node-server';
import { CanvasClient } from '@planner/canvas';
import { createApp } from './app';
import { CanvasIcsSource } from './canvas/canvas-ics-source';
import { CanvasSource } from './canvas/canvas-source';
import { createDb } from './db/client';
import { loadEnv } from './env';
import { GoogleCalendarClient } from './google/calendar-client';
import { GoogleCalendarSource } from './google/calendar-source';
import { GOOGLE_REVOKE_URL, GoogleAuth, REFRESH_TOKEN_KEY } from './google/oauth';
import { GoogleTasksClient } from './google/tasks-client';
import { ItemCreator } from './inbound/creator';
import { createInbound } from './inbound/setup';
import { integrationStatus } from './integrations';
import { log, sanitizeError } from './log';
import { createClaudeExtractor } from './parser/claude-extractor';
import { MessageParser } from './parser/parser';
import type { CalendarWriter } from './routes/calendar';
import { createTokenStore, type TokenStore } from './secrets/token-store';
import { cloudflareAccessVerifier } from './security/auth';
import type { SecurityConfig } from './security/middleware';
import { SettingsStore } from './settings';
import { SyncScheduler } from './sync/scheduler';
import type { SyncSource } from './sync/types';

// Never let a crash print an unsanitized error (which could carry a token or message text).
process.on('uncaughtException', (e) => {
  log.error('uncaught exception', { error: sanitizeError(e) });
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  log.error('unhandled rejection', { error: sanitizeError(e) });
});

const env = loadEnv();
const db = createDb(env.DATABASE_PATH);
const now = () => new Date();
const settings = new SettingsStore(db, now);
const sources: SyncSource[] = [];
let calendar: CalendarWriter | undefined;
let googleTasks: GoogleTasksClient | undefined;
let tokenStore: TokenStore | null = null;

if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  tokenStore = await createTokenStore(env);
  const auth = new GoogleAuth(
    { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    tokenStore,
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
  log.info('google enabled', { tokenStore: tokenStore.kind });
} else {
  log.info('google disabled (GOOGLE_CLIENT_ID/SECRET not set)');
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

// One parser and creator shared by the web quick-add and inbound messages.
const llm = env.PARSER_LLM_ENABLED && env.ANTHROPIC_API_KEY ? createClaudeExtractor(env) : null;
const parser = new MessageParser({
  llm,
  llmEnabled: () => settings.get().aiTriage,
  timeZone: env.APP_TIMEZONE,
  now,
});
const creator = new ItemCreator({
  db,
  now,
  timeZone: env.APP_TIMEZONE,
  calendar: calendar && { client: calendar.client, calendarId: calendar.defaultCalendarId },
  tasks: googleTasks,
});
log.info('message parser', { llm: Boolean(llm), model: llm ? env.PARSER_MODEL : null });

async function disconnectGoogle(store: TokenStore) {
  const token = await store.get(REFRESH_TOKEN_KEY);
  if (token) {
    await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    }).catch(() => undefined);
  }
  await store.delete(REFRESH_TOKEN_KEY);
}

const security: SecurityConfig | undefined =
  env.AUTH_MODE === 'none' && !env.PUBLIC_BASE_URL
    ? undefined
    : {
        auth:
          env.AUTH_MODE === 'password'
            ? {
                mode: 'password',
                passwordHash: env.AUTH_PASSWORD_HASH!,
                sessionSecret: env.SESSION_SECRET!,
                sessionTtlMs: env.SESSION_TTL_DAYS * 86_400_000,
              }
            : env.AUTH_MODE === 'cloudflare'
              ? {
                  mode: 'cloudflare',
                  verify: cloudflareAccessVerifier(env.CF_ACCESS_TEAM_DOMAIN!, env.CF_ACCESS_AUD!),
                }
              : { mode: 'none' },
        publicOrigin: env.PUBLIC_BASE_URL ? new URL(env.PUBLIC_BASE_URL).origin : undefined,
        trustProxy: env.TRUST_PROXY,
        webhookRateLimitPerMin: env.WEBHOOK_RATE_LIMIT_PER_MIN,
      };
log.info('access control', { auth: env.AUTH_MODE, webUi: Boolean(env.WEB_DIST_DIR) });

const scheduler = new SyncScheduler(db, sources);
const inbound = createInbound(env, { db, now, parser, creator });
const app = createApp({
  db,
  scheduler,
  now,
  timeZone: env.APP_TIMEZONE,
  settings,
  calendar,
  inbound: inbound ? { pipeline: inbound.pipeline, channels: inbound.channels } : undefined,
  capture: { parser, creator },
  integrations: integrationStatus(env, { db, scheduler, tokenStore, llmAvailable: Boolean(llm) }),
  disconnectGoogle: tokenStore ? () => disconnectGoogle(tokenStore!) : undefined,
  security,
  webDist: env.WEB_DIST_DIR,
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
