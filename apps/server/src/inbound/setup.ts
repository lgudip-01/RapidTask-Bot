import type { Db } from '../db/client';
import { appOrigins, type Env } from '../env';
import { log } from '../log';
import type { MessageParser } from '../parser/parser';
import type { ItemCreator } from './creator';
import { InboundPipeline } from './pipeline';
import { TelegramApi, TelegramChannel, TelegramPoller } from './telegram';
import { TwilioChannel } from './twilio';
import type { InboundChannel } from './types';

export interface InboundSetup {
  pipeline: InboundPipeline;
  channels: Partial<Record<'telegram' | 'twilio', InboundChannel>>;
  poller: TelegramPoller | null;
}

/** Builds whichever channels are fully configured. Returns null when none are. */
export function createInbound(
  env: Env,
  deps: {
    db: Db;
    now: () => Date;
    parser: MessageParser;
    creator: ItemCreator;
    onChange?: (topic: 'items' | 'suggestions') => void;
  },
): InboundSetup | null {
  const pipeline = new InboundPipeline({
    db: deps.db,
    parser: deps.parser,
    creator: deps.creator,
    timeZone: env.APP_TIMEZONE,
    now: deps.now,
    rateLimit: { limit: env.INBOUND_RATE_LIMIT_PER_10_MIN, windowMs: 10 * 60_000 },
    onChange: deps.onChange,
  });
  const channels: InboundSetup['channels'] = {};
  let poller: TelegramPoller | null = null;

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALLOWED_USER_ID) {
    const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN);
    const telegram = new TelegramChannel({
      api,
      allowedUserId: env.TELEGRAM_ALLOWED_USER_ID,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    });
    if (env.TELEGRAM_MODE === 'webhook') {
      if (!env.TELEGRAM_WEBHOOK_SECRET)
        throw new Error('TELEGRAM_WEBHOOK_SECRET is required in webhook mode');
      channels.telegram = telegram;
    } else {
      // Polling: updates come from Telegram over TLS with our token; no webhook route.
      poller = new TelegramPoller(api, (msg) => pipeline.submit(telegram, msg));
    }
    log.info('telegram enabled', { mode: env.TELEGRAM_MODE });
  }

  if (
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    env.TWILIO_FROM_NUMBER &&
    env.OWNER_PHONE_E164
  ) {
    const origin = appOrigins(env).primary;
    const webhookUrl =
      env.TWILIO_WEBHOOK_URL ?? (origin ? new URL('/webhooks/twilio', origin).toString() : null);
    if (!webhookUrl)
      throw new Error('Set PUBLIC_BASE_URL (or TWILIO_WEBHOOK_URL) for Twilio signature checks');
    channels.twilio = new TwilioChannel({
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      fromNumber: env.TWILIO_FROM_NUMBER,
      ownerNumber: env.OWNER_PHONE_E164,
      webhookUrl,
    });
    log.info('twilio enabled');
  }

  if (!poller && !Object.keys(channels).length) return null;
  return { pipeline, channels, poller };
}
