import { timingSafeEqual } from 'node:crypto';
import type { FetchFn } from '../google/oauth';
import { log, sanitizeError } from '../log';
import type { InboundChannel, InboundRequest, IncomingMessage } from './types';

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';
const MAX_REPLY = 4000;

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    from?: { id: number; is_bot?: boolean };
    chat: { id: number; type: string };
  };
}

export class TelegramApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Bot API calls. The token is part of the URL, so URLs are never logged. */
export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (!res.ok || !json.ok) {
      throw new TelegramApiError(
        res.status,
        `Telegram ${method} ${res.status}: ${json.description ?? 'error'}`,
      );
    }
    return json.result as T;
  }

  sendMessage(chatId: string, text: string) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, MAX_REPLY),
      link_preview_options: { is_disabled: true },
    });
  }
  getUpdates(offset: number | undefined, timeoutSec: number, signal?: AbortSignal) {
    return this.call<TgUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message'] },
      signal,
    );
  }
  setWebhook(url: string, secretToken: string) {
    return this.call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message'],
      drop_pending_updates: false,
    });
  }
  deleteWebhook() {
    return this.call('deleteWebhook', { drop_pending_updates: false });
  }
  getWebhookInfo() {
    return this.call<{ url: string; pending_update_count: number; last_error_message?: string }>(
      'getWebhookInfo',
    );
  }
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Text messages in a private chat only. */
export function telegramUpdateToMessage(u: TgUpdate): IncomingMessage | null {
  const m = u.message;
  if (!m || typeof m.text !== 'string' || !m.from || m.from.is_bot) return null;
  if (m.chat.type !== 'private') return null;
  return {
    senderId: String(m.from.id),
    text: m.text,
    receivedAt: new Date(m.date * 1000),
    messageId: String(u.update_id),
  };
}

export interface TelegramChannelOptions {
  api: TelegramApi;
  /** Numeric Telegram user id of the owner. */
  allowedUserId: string;
  /** secret_token registered with setWebhook (webhook mode). */
  webhookSecret?: string;
}

export class TelegramChannel implements InboundChannel {
  readonly name = 'telegram' as const;
  constructor(private readonly opts: TelegramChannelOptions) {}

  verifyRequest(req: InboundRequest): boolean {
    const got = req.headers.get(TELEGRAM_SECRET_HEADER);
    return Boolean(this.opts.webhookSecret && got && safeEqual(got, this.opts.webhookSecret));
  }

  parseIncoming(req: InboundRequest): IncomingMessage | null {
    try {
      return telegramUpdateToMessage(JSON.parse(req.body) as TgUpdate);
    } catch {
      return null;
    }
  }

  isAllowed(msg: IncomingMessage) {
    return msg.senderId === this.opts.allowedUserId;
  }

  async reply(senderId: string, text: string) {
    // In a private chat, chat id == user id.
    await this.opts.api.sendMessage(senderId, text);
  }

  ack() {
    return { body: '', contentType: 'text/plain' };
  }
}

/**
 * Local development: long-poll getUpdates (no public URL needed). Telegram refuses getUpdates
 * with 409 while a webhook is registered; run `npm run telegram -- delete-webhook` first.
 */
export class TelegramPoller {
  private offset: number | undefined;
  private running = false;
  private abort: AbortController | null = null;

  constructor(
    private readonly api: TelegramApi,
    private readonly onMessage: (msg: IncomingMessage) => Promise<void>,
    private readonly opts: { timeoutSec?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  /** One getUpdates round; returns how many updates were handled. */
  async pollOnce(): Promise<number> {
    this.abort = new AbortController();
    const updates = await this.api.getUpdates(
      this.offset,
      this.opts.timeoutSec ?? 50,
      this.abort.signal,
    );
    for (const u of updates) {
      this.offset = u.update_id + 1;
      const msg = telegramUpdateToMessage(u);
      if (msg) await this.onMessage(msg);
    }
    return updates.length;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const sleep = this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    void (async () => {
      let backoff = 1000;
      while (this.running) {
        try {
          await this.pollOnce();
          backoff = 1000;
        } catch (e) {
          if (!this.running) break;
          if (e instanceof TelegramApiError && e.status === 409) {
            log.error(
              'telegram polling blocked by a registered webhook; run `npm run telegram -- delete-webhook`',
            );
          } else {
            log.warn('telegram poll failed', { error: sanitizeError(e) });
          }
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    })();
  }

  stop() {
    this.running = false;
    this.abort?.abort();
  }
}
