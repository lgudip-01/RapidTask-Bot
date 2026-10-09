import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FetchFn } from '../google/oauth';
import type { InboundChannel, InboundRequest, IncomingMessage } from './types';

export const TWILIO_SIGNATURE_HEADER = 'x-twilio-signature';
const MAX_SMS = 1500;

/**
 * Twilio request signature: base64(HMAC-SHA1(authToken, url + concat(sorted(key + value)))).
 * `url` must be exactly the URL configured in Twilio (scheme, host, path, query).
 */
export function twilioSignature(authToken: string, url: string, params: URLSearchParams): string {
  const keys = [...new Set(params.keys())].sort();
  let data = url;
  for (const k of keys) for (const v of params.getAll(k)) data += k + v;
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

/** Normalizes a US/E.164 phone number for comparison. */
export function normalizeE164(n: string) {
  const digits = n.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export interface TwilioChannelOptions {
  accountSid: string;
  authToken: string;
  /** Our Twilio number (E.164), used as the sender of replies. */
  fromNumber: string;
  /** The owner's phone number (E.164). */
  ownerNumber: string;
  /** Public URL Twilio posts to, exactly as configured on the number. */
  webhookUrl: string;
  fetch?: FetchFn;
}

export class TwilioChannel implements InboundChannel {
  readonly name = 'twilio' as const;
  constructor(private readonly opts: TwilioChannelOptions) {}

  verifyRequest(req: InboundRequest): boolean {
    const got = req.headers.get(TWILIO_SIGNATURE_HEADER);
    if (!got) return false;
    const expected = twilioSignature(
      this.opts.authToken,
      this.opts.webhookUrl,
      new URLSearchParams(req.body),
    );
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseIncoming(req: InboundRequest): IncomingMessage | null {
    const p = new URLSearchParams(req.body);
    const from = p.get('From');
    const sid = p.get('MessageSid') ?? p.get('SmsMessageSid');
    const body = p.get('Body');
    if (!from || !sid || body === null) return null;
    if (p.get('AccountSid') !== this.opts.accountSid) return null;
    return { senderId: normalizeE164(from), text: body, receivedAt: new Date(), messageId: sid };
  }

  isAllowed(msg: IncomingMessage) {
    return msg.senderId === normalizeE164(this.opts.ownerNumber);
  }

  /** Replies via the REST API (the webhook was already acknowledged with empty TwiML). */
  async reply(senderId: string, text: string) {
    const { accountSid, authToken, fromNumber } = this.opts;
    const res = await (this.opts.fetch ?? fetch)(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: senderId, From: fromNumber, Body: text.slice(0, MAX_SMS) }),
      },
    );
    if (!res.ok) throw new Error(`Twilio send ${res.status}`);
  }

  ack() {
    return {
      body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      contentType: 'text/xml',
    };
  }
}
