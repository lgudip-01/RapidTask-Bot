import { CanvasClient } from '@planner/canvas';
import { zonedTimeToUtc } from '@planner/shared';
import { createApp, type AppDeps } from './app';
import { BackupService, type BackupTarget } from './backup/backup';
import { CanvasIcsSource } from './canvas/canvas-ics-source';
import { CanvasSource } from './canvas/canvas-source';
import { ChangeBus } from './changes';
import { createDb } from './db/client';
import { isServerless, type Env } from './env';
import { GoogleCalendarClient } from './google/calendar-client';
import { GoogleCalendarSource } from './google/calendar-source';
import { GOOGLE_REVOKE_URL, GoogleAuth, REFRESH_TOKEN_KEY } from './google/oauth';
import { ItemCreator } from './inbound/creator';
import { createInbound } from './inbound/setup';
import { TelegramApi } from './inbound/telegram';
import { integrationStatus } from './integrations';
import { log, sanitizeError } from './log';
import { Notifier } from './notify/notifier';
import { createClaudeExtractor } from './parser/claude-extractor';
import { MessageParser } from './parser/parser';
import { createTokenStore, type TokenStore } from './secrets/token-store';
import { cloudflareAccessVerifier } from './security/auth';
import type { SecurityConfig } from './security/middleware';
import { SettingsStore } from './settings';
import { SyncScheduler } from './sync/scheduler';
import type { SyncSource } from './sync/types';

export type Runtime = Awaited<ReturnType<typeof createRuntime>>;

/**
 * Builds the whole server from the environment. Used by both entry points: the long-running Node
 * server (`index.ts`: timers, polling, SSE) and the Vercel function (`vercel.ts`: cron-driven).
 */
export async function createRuntime(
  env: Env,
  opts: { background?: (work: Promise<unknown>) => void } = {},
) {
  const serverless = isServerless(env);
  const db = await createDb(env.TURSO_DATABASE_URL ?? env.DATABASE_PATH, env.TURSO_AUTH_TOKEN);
  const now = () => new Date();
  const settings = new SettingsStore(db, now);
  const sources: SyncSource[] = [];
  const changes = new ChangeBus();
  let tokenStore: TokenStore | null = null;

  const googleClient =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
      : null;
  if (googleClient) {
    tokenStore = await createTokenStore(
      { ...env, TOKEN_STORE: serverless && env.TOKEN_STORE === 'auto' ? 'db' : env.TOKEN_STORE },
      db,
    );
    const auth = new GoogleAuth(googleClient, tokenStore);
    sources.push(
      new GoogleCalendarSource(new GoogleCalendarClient(auth), {
        calendarIds: env.GOOGLE_CALENDAR_IDS,
        appTimeZone: env.APP_TIMEZONE,
        intervalMs: env.GOOGLE_SYNC_INTERVAL_MINUTES * 60_000,
        lookbackDays: env.GOOGLE_SYNC_LOOKBACK_DAYS,
      }),
    );
    log.info('google calendar enabled (read-only)', { tokenStore: tokenStore.kind });
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
    llmEnabled: async () => (await settings.get()).aiTriage,
    timeZone: env.APP_TIMEZONE,
    now,
  });
  // Everything created from texts or the UI lives only in this app's database.
  const creator = new ItemCreator({ db, now });
  if (env.WRITE_EVENTS_TO_GOOGLE) {
    log.warn(
      'WRITE_EVENTS_TO_GOOGLE is set but not implemented yet; ignoring (Google is read-only)',
    );
  }
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
                    verify: cloudflareAccessVerifier(
                      env.CF_ACCESS_TEAM_DOMAIN!,
                      env.CF_ACCESS_AUD!,
                    ),
                  }
                : { mode: 'none' },
          publicOrigin: env.PUBLIC_BASE_URL ? new URL(env.PUBLIC_BASE_URL).origin : undefined,
          // Vercel always sits behind its proxy, which sets X-Forwarded-For.
          trustProxy: env.TRUST_PROXY || serverless,
          webhookRateLimitPerMin: env.WEBHOOK_RATE_LIMIT_PER_MIN,
          healthRateLimitPerMin: env.HEALTH_RATE_LIMIT_PER_MIN,
        };
  log.info('access control', { auth: env.AUTH_MODE, webUi: Boolean(env.WEB_DIST_DIR) });

  const scheduler = new SyncScheduler(db, sources, { onChange: (t) => changes.emit(t) });
  const inbound = createInbound(env, {
    db,
    now,
    parser,
    creator,
    onChange: (t) => changes.emit(t),
  });

  // Health alerts and (on serverless) backups go to the owner over Telegram when configured.
  const telegram =
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALLOWED_USER_ID
      ? { api: new TelegramApi(env.TELEGRAM_BOT_TOKEN), owner: env.TELEGRAM_ALLOWED_USER_ID }
      : null;
  const telegramAlert = telegram
    ? async (text: string) => {
        await telegram.api.sendMessage(telegram.owner, text);
      }
    : undefined;

  const wantTarget =
    env.BACKUP_TARGET === 'auto' ? (serverless ? 'telegram' : 'file') : env.BACKUP_TARGET;
  let target: BackupTarget | null = null;
  if (wantTarget === 'file') {
    target = { kind: 'file', dir: env.BACKUP_DIR, keep: env.BACKUP_KEEP };
  } else if (telegram) {
    target = {
      kind: 'telegram',
      send: (fileName, content, caption) =>
        telegram.api.sendDocument(telegram.owner, fileName, content, caption),
    };
  } else {
    log.warn('backups disabled: BACKUP_TARGET=telegram needs TELEGRAM_BOT_TOKEN and owner id');
  }
  const backups = target
    ? new BackupService(db, {
        target,
        hour: env.BACKUP_HOUR,
        timeZone: env.APP_TIMEZONE,
        enabled: env.BACKUP_ENABLED,
        onChange: (t) => changes.emit(t),
      })
    : undefined;

  const ymd = (d: string) => d.split('-').map(Number) as [number, number, number];
  const notifier =
    env.NOTIFICATIONS_ENABLED && telegramAlert
      ? new Notifier(db, {
          timeZone: env.APP_TIMEZONE,
          settings: () => settings.get(),
          send: telegramAlert,
          backupStatus: backups ? () => backups.status() : undefined,
          canvasTokenExpiresAt: env.CANVAS_TOKEN_EXPIRES_AT
            ? zonedTimeToUtc(env.APP_TIMEZONE, ...ymd(env.CANVAS_TOKEN_EXPIRES_AT))
            : undefined,
          syncFailureThreshold: env.SYNC_FAILURE_ALERT_THRESHOLD,
        })
      : null;
  log.info('notifications', { enabled: Boolean(notifier) });

  /** One serverless heartbeat: due syncs, then messages, then the nightly backup. */
  async function tick() {
    const out: Record<string, unknown> = {};
    try {
      const runs = await scheduler.runDue();
      out.sync = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.ok]));
    } catch (e) {
      log.error('cron sync failed', { error: sanitizeError(e) });
      out.sync = 'error';
    }
    if (notifier) {
      await notifier.tick();
      out.notifications = true;
    }
    if (backups) {
      const run = await backups.runIfDue();
      out.backup = run ? (run.ok ? 'ok' : 'failed') : 'not_due';
    }
    return out;
  }

  const deps: AppDeps = {
    db,
    scheduler,
    now,
    timeZone: env.APP_TIMEZONE,
    settings,
    changes,
    backups,
    writeEventsToGoogle: env.WRITE_EVENTS_TO_GOOGLE,
    inbound: inbound ? { pipeline: inbound.pipeline, channels: inbound.channels } : undefined,
    capture: { parser, creator },
    integrations: integrationStatus(env, { db, scheduler, tokenStore, llmAvailable: Boolean(llm) }),
    disconnectGoogle: tokenStore ? () => disconnectGoogle(tokenStore!) : undefined,
    google:
      googleClient && tokenStore
        ? {
            client: googleClient,
            tokenStore,
            publicOrigin: env.PUBLIC_BASE_URL ? new URL(env.PUBLIC_BASE_URL).origin : undefined,
            onConnected: () => scheduler.run('google_calendar'),
          }
        : undefined,
    security,
    webDist: env.WEB_DIST_DIR,
    background: opts.background,
    cron: env.CRON_SECRET ? { secret: env.CRON_SECRET, tick } : undefined,
    streaming: !serverless,
  };

  return {
    env,
    db,
    app: createApp(deps),
    scheduler,
    notifier,
    backups,
    inbound,
    sources,
    tick,
  };
}
