import { describe, expect, it } from 'vitest';
import {
  inboundHarness,
  OWNER_TG,
  ownerUpdate,
  twilioFixture,
  TWILIO,
} from '../../test/inbound-harness';
import { loadFixture } from '../../test/helpers';
import { calendarEvents, inboundMessages, tasks } from '../db/schema';
import { LogThrottle, SlidingWindowLimiter } from './rate-limit';
import { TelegramApi, TelegramApiError, TelegramPoller, telegramUpdateToMessage } from './telegram';
import { normalizeE164, twilioSignature } from './twilio';
import { fakeFetch } from '../../test/fake-fetch';

describe('Twilio signature', () => {
  it("matches Twilio's published example", () => {
    const params = new URLSearchParams({
      CallSid: 'CA1234567890ABCDE',
      Caller: '+14158675310',
      Digits: '1234',
      From: '+14158675310',
      To: '+18005551212',
    });
    expect(twilioSignature('12345', 'https://example.com/myapp.php?foo=1&bar=2', params)).toBe(
      'L/OH5YylLD5NRKLltdqwSvS0BnU=',
    );
  });

  it('accepts a valid signature and replies via the REST API', async () => {
    const h = await inboundHarness();
    const res = await h.postTwilio(twilioFixture());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    expect(await res.text()).toContain('<Response></Response>');
    expect(h.smsReplies()).toEqual([
      'Added task: Call mom — due Sat, Oct 10. Reply UNDO to remove.',
    ]);
    const send = h.twilioApi.calls[0]!;
    expect(send.url.pathname).toBe(`/2010-04-01/Accounts/${TWILIO.accountSid}/Messages.json`);
    expect(send.body).toMatchObject({ To: '+15555550123', From: TWILIO.fromNumber });
  });

  it.each([
    ['missing', null],
    ['wrong token', 'x'],
    ['different URL', 'url'],
    ['tampered body', 'tamper'],
  ])('rejects a %s signature with 403 and does nothing', async (_name, kind) => {
    const h = await inboundHarness();
    const body = twilioFixture();
    let signature: string | null = null;
    let sent = body;
    if (kind === 'x') signature = h.signTwilio(body, TWILIO.webhookUrl, 'not-the-token');
    if (kind === 'url') signature = h.signTwilio(body, 'https://evil.example.com/webhooks/twilio');
    if (kind === 'tamper') {
      signature = h.signTwilio(body);
      sent = body.replace('call+mom+tomorrow', 'delete+everything');
    }
    expect((await h.postTwilio(sent, signature)).status).toBe(403);
    expect(await h.db.select().from(inboundMessages).all()).toHaveLength(0);
    expect(h.smsReplies()).toHaveLength(0);
  });

  it('a replayed (validly signed) request is deduplicated by MessageSid', async () => {
    const h = await inboundHarness();
    const body = twilioFixture();
    await h.postTwilio(body);
    const replay = await h.postTwilio(body);
    expect(replay.status).toBe(200);
    expect(await h.db.select().from(tasks).all()).toHaveLength(1);
    expect(await h.db.select().from(inboundMessages).all()).toHaveLength(1);
    expect(h.smsReplies()).toHaveLength(1);
  });

  it('drops SMS from any number but the owner, silently', async () => {
    const h = await inboundHarness();
    const body = twilioFixture().replace('From=%2B15555550123', 'From=%2B15555550999');
    expect((await h.postTwilio(body)).status).toBe(200);
    expect(h.smsReplies()).toHaveLength(0);
    expect(await h.db.select().from(inboundMessages).all()).toHaveLength(0);
  });

  it('ignores requests for another Twilio account', async () => {
    const h = await inboundHarness();
    const body = twilioFixture().replace(TWILIO.accountSid, 'ACbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect((await h.postTwilio(body)).status).toBe(200);
    expect(h.smsReplies()).toHaveLength(0);
  });

  it('normalizes E.164 numbers', () => {
    expect(normalizeE164('+1 (555) 555-0123')).toBe('+15555550123');
    expect(normalizeE164('15555550123')).toBe('+15555550123');
  });
});

describe('Telegram webhook', () => {
  it('accepts the secret-token header and replies in the chat', async () => {
    const h = await inboundHarness();
    const res = await h.postTelegram(loadFixture('inbound/telegram-text.json'));
    expect(res.status).toBe(200);
    expect(h.telegramReplies()).toEqual([
      'Added event: Dentist — Tue, Oct 13, 3:00–4:00 PM. Reply UNDO to remove.',
    ]);
    const call = h.telegramApi.calls[0]!;
    expect(call.url.pathname).toBe('/bot123:test-bot-token/sendMessage');
    expect(call.body).toMatchObject({ chat_id: OWNER_TG });
    expect(await h.db.select().from(calendarEvents).all()).toHaveLength(1);
  });

  it.each([
    ['missing', null],
    ['wrong', 'wrong_secret_0123456789abcdef'],
    ['prefix of the real one', 'test_webhook_secret_01234'],
  ])('rejects a %s secret token with 403', async (_n, secret) => {
    const h = await inboundHarness();
    expect((await h.postTelegram(loadFixture('inbound/telegram-text.json'), secret)).status).toBe(
      403,
    );
    expect(await h.db.select().from(inboundMessages).all()).toHaveLength(0);
    expect(h.telegramReplies()).toHaveLength(0);
  });

  it('deduplicates Telegram retries of the same update_id', async () => {
    const h = await inboundHarness();
    const update = loadFixture('inbound/telegram-text.json');
    for (let i = 0; i < 3; i++) expect((await h.postTelegram(update)).status).toBe(200);
    expect(await h.db.select().from(calendarEvents).all()).toHaveLength(1);
    expect(h.telegramReplies()).toHaveLength(1);
  });

  it('drops strangers, group chats, and non-text updates silently', async () => {
    const h = await inboundHarness();
    for (const f of ['telegram-stranger', 'telegram-group', 'telegram-photo']) {
      expect((await h.postTelegram(loadFixture(`inbound/${f}.json`))).status).toBe(200);
    }
    expect(h.telegramReplies()).toHaveLength(0);
    expect(await h.db.select().from(inboundMessages).all()).toHaveLength(0);
    expect(await h.db.select().from(tasks).all()).toHaveLength(0);
  });

  it('maps updates to messages', () => {
    expect(telegramUpdateToMessage(ownerUpdate('hi', 42))).toEqual({
      senderId: OWNER_TG,
      text: 'hi',
      receivedAt: new Date(1791561600 * 1000),
      messageId: '42',
    });
  });
});

describe('Telegram polling', () => {
  it('feeds getUpdates results to the handler and advances the offset', async () => {
    let call = 0;
    const api = fakeFetch((req) => {
      call++;
      if (call === 1)
        return {
          status: 200,
          json: { ok: true, result: [ownerUpdate('a', 10), ownerUpdate('b', 11)] },
        };
      expect((req.body as { offset: number }).offset).toBe(12);
      return { status: 200, json: { ok: true, result: [] } };
    });
    const got: string[] = [];
    const poller = new TelegramPoller(new TelegramApi('t', api), async (m) => {
      got.push(m.text);
    });
    expect(await poller.pollOnce()).toBe(2);
    expect(await poller.pollOnce()).toBe(0);
    expect(got).toEqual(['a', 'b']);
  });

  it('surfaces 409 Conflict when a webhook is still registered', async () => {
    const api = fakeFetch(() => ({
      status: 409,
      json: {
        ok: false,
        description: "Conflict: can't use getUpdates method while webhook is active",
      },
    }));
    const poller = new TelegramPoller(new TelegramApi('t', api), async () => {});
    const err = await poller.pollOnce().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).status).toBe(409);
  });
});

describe('rate limiting helpers', () => {
  it('limits per key within a sliding window', () => {
    let t = 0;
    const l = new SlidingWindowLimiter(2, 1000, () => t);
    expect([l.allow('a'), l.allow('a'), l.allow('a'), l.allow('b')]).toEqual([
      true,
      true,
      false,
      true,
    ]);
    t = 1001;
    expect(l.allow('a')).toBe(true);
  });

  it('throttles drop logging to one line per interval', () => {
    let t = 0;
    const th = new LogThrottle(60_000, () => t);
    expect(th.hit('x')).toBe(0);
    expect(th.hit('x')).toBeNull();
    expect(th.hit('x')).toBeNull();
    t = 60_000;
    expect(th.hit('x')).toBe(2);
  });
});
