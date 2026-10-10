import type { IntegrationStatus, SyncStatus } from '@planner/shared';
import type { Db } from './db/client';
import { toSyncStatusJson } from './db/mappers';
import { syncState } from './db/schema';
import type { Env } from './env';
import { REFRESH_TOKEN_KEY } from './google/oauth';
import type { TokenStore } from './secrets/token-store';
import type { SyncScheduler } from './sync/scheduler';

const mask = (s: string, keep = 4) => `••••${s.slice(-keep)}`;

/** What Settings shows: each integration, how it is configured, and its last sync. Never secrets. */
export function integrationStatus(
  env: Env,
  deps: { db: Db; scheduler: SyncScheduler; tokenStore: TokenStore | null; llmAvailable: boolean },
) {
  return async (): Promise<IntegrationStatus[]> => {
    const live = new Map(deps.scheduler.status().map((s) => [s.source, s]));
    const persisted = new Map(
      deps.db
        .select()
        .from(syncState)
        .all()
        .map((r) => [r.source, r]),
    );
    const sync = (name: string): SyncStatus | null =>
      live.get(name) ??
      (persisted.has(name) ? toSyncStatusJson(name, persisted.get(name), false) : null);

    const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
    const googleConnected =
      googleConfigured && deps.tokenStore
        ? (await deps.tokenStore.get(REFRESH_TOKEN_KEY).catch(() => null)) !== null
        : null;
    const canvasMode =
      env.CANVAS_BASE_URL && env.CANVAS_TOKEN ? 'rest' : env.CANVAS_ICS_URL ? 'ics' : null;
    const telegramConfigured = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALLOWED_USER_ID);
    const twilioConfigured = Boolean(
      env.TWILIO_ACCOUNT_SID &&
      env.TWILIO_AUTH_TOKEN &&
      env.TWILIO_FROM_NUMBER &&
      env.OWNER_PHONE_E164,
    );

    return [
      {
        id: 'google_calendar',
        label: 'Google Calendar',
        configured: googleConfigured,
        detail: googleConfigured ? (deps.tokenStore?.kind ?? null) : null,
        connected: googleConnected,
        sync: sync('google_calendar'),
        help:
          googleConnected === false
            ? 'Run `npm run auth:google -w @planner/server` to connect.'
            : null,
      },
      {
        id: 'canvas',
        label: 'Canvas',
        configured: canvasMode !== null,
        detail: canvasMode,
        connected: canvasMode !== null,
        sync: sync('canvas'),
        help: canvasMode ? null : 'Set CANVAS_BASE_URL + CANVAS_TOKEN (or CANVAS_ICS_URL) in .env.',
      },
      {
        id: 'telegram',
        label: 'Telegram',
        configured: telegramConfigured,
        detail: telegramConfigured
          ? `${env.TELEGRAM_MODE} · user ${mask(env.TELEGRAM_ALLOWED_USER_ID!)}`
          : null,
        connected: null,
        sync: null,
        help: telegramConfigured
          ? null
          : 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID in .env.',
      },
      {
        id: 'twilio',
        label: 'SMS (Twilio)',
        configured: twilioConfigured,
        detail: twilioConfigured ? `owner ${mask(env.OWNER_PHONE_E164!)}` : null,
        connected: null,
        sync: null,
        help: twilioConfigured ? null : 'Set the TWILIO_* variables and OWNER_PHONE_E164 in .env.',
      },
      {
        id: 'parser',
        label: 'AI triage (Claude)',
        configured: deps.llmAvailable,
        detail: deps.llmAvailable ? env.PARSER_MODEL : null,
        connected: null,
        sync: null,
        help: deps.llmAvailable ? null : 'Set ANTHROPIC_API_KEY to parse free-form messages.',
      },
    ];
  };
}
