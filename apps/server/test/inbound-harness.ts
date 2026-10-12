import type { AppDeps } from '../src/app';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ItemCreator } from '../src/inbound/creator';
import { InboundPipeline } from '../src/inbound/pipeline';
import {
  TelegramApi,
  TelegramChannel,
  TELEGRAM_SECRET_HEADER,
  type TgUpdate,
} from '../src/inbound/telegram';
import { TwilioChannel, TWILIO_SIGNATURE_HEADER, twilioSignature } from '../src/inbound/twilio';
import type { LlmExtractor } from '../src/parser/claude-extractor';
import { MessageParser } from '../src/parser/parser';
import { fakeFetch } from './fake-fetch';
import { loadFixture, makeTestEnv } from './helpers';

export const NOW = '2026-10-09T16:00:00.000Z'; // Fri 12:00 EDT
export const TZ = 'America/New_York';
export const OWNER_TG = '123456789';
export const TG_SECRET = 'test_webhook_secret_0123456789';
export const OWNER_PHONE = '+15555550123';
export const TWILIO = {
  accountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  authToken: 'twilio-test-auth-token',
  fromNumber: '+15555550100',
  webhookUrl: 'https://planner.example.com/webhooks/twilio',
};

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'inbound');
export const twilioFixture = () => fs.readFileSync(path.join(dir, 'twilio-sms.txt'), 'utf8');

let nextUpdateId = 731100000;
/** A Telegram update from the owner, shaped like the recorded fixture. */
export function ownerUpdate(text: string, updateId = nextUpdateId++) {
  const u = structuredClone(
    loadFixture<TgUpdate & { message: { text: string; message_id: number } }>(
      'inbound/telegram-text.json',
    ),
  );
  u.update_id = updateId;
  u.message.message_id = updateId % 100000;
  u.message.text = text;
  return u;
}

export interface HarnessOptions {
  llm?: LlmExtractor | null;
  /** Receives the pipeline's change notifications. */
  onChange?: (topic: 'items' | 'suggestions') => void;
  rateLimit?: { limit: number; windowMs: number };
  /** Serverless keep-alive for webhook processing. */
  background?: AppDeps['background'];
}

export async function inboundHarness(opts: HarnessOptions = {}) {
  const telegramApi = fakeFetch(() => ({
    status: 200,
    json: { ok: true, result: { message_id: 1 } },
  }));
  const twilioApi = fakeFetch(() => ({ status: 201, json: { sid: 'SMreply' } }));
  let pipeline!: InboundPipeline;
  let parser!: MessageParser;

  const env = await makeTestEnv([], NOW, (db, now) => {
    parser = new MessageParser({ llm: opts.llm ?? null, timeZone: TZ, now });
    const creator = new ItemCreator({ db, now });
    pipeline = new InboundPipeline({
      db,
      parser,
      creator,
      timeZone: TZ,
      now,
      rateLimit: opts.rateLimit,
      onChange: opts.onChange,
    });
    const telegram = new TelegramChannel({
      api: new TelegramApi('123:test-bot-token', telegramApi),
      allowedUserId: OWNER_TG,
      webhookSecret: TG_SECRET,
    });
    const twilio = new TwilioChannel({ ...TWILIO, ownerNumber: OWNER_PHONE, fetch: twilioApi });
    return { inbound: { pipeline, channels: { telegram, twilio } }, background: opts.background };
  });

  const postTelegram = async (update: unknown, secret: string | null = TG_SECRET) => {
    const res = await env.app.request('/webhooks/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret !== null && { [TELEGRAM_SECRET_HEADER]: secret }),
      },
      body: JSON.stringify(update),
    });
    await pipeline.idle();
    return res;
  };

  const signTwilio = (body: string, url = TWILIO.webhookUrl, token = TWILIO.authToken) =>
    twilioSignature(token, url, new URLSearchParams(body));

  const postTwilio = async (body: string, signature: string | null = signTwilio(body)) => {
    const res = await env.app.request('/webhooks/twilio', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(signature !== null && { [TWILIO_SIGNATURE_HEADER]: signature }),
      },
      body,
    });
    await pipeline.idle();
    return res;
  };

  /** Owner sends `text` over Telegram; returns the bot's reply. */
  const say = async (text: string) => {
    const before = telegramApi.calls.length;
    await postTelegram(ownerUpdate(text));
    const sent = telegramApi.calls.slice(before).map((c) => (c.body as { text: string }).text);
    return sent.join('\n');
  };

  return {
    ...env,
    get pipeline() {
      return pipeline;
    },
    get parser() {
      return parser;
    },
    telegramApi,
    twilioApi,
    postTelegram,
    postTwilio,
    signTwilio,
    say,
    telegramReplies: () => telegramApi.calls.map((c) => (c.body as { text: string }).text),
    smsReplies: () => twilioApi.calls.map((c) => (c.body as Record<string, string>).Body),
  };
}
