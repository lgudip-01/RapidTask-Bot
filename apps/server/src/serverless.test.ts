import { describe, expect, it } from 'vitest';
import { fakeFetch } from '../test/fake-fetch';
import { fakeSource, makeTestEnv } from '../test/helpers';
import { inboundHarness, ownerUpdate } from '../test/inbound-harness';
import { secrets } from './db/schema';
import { loadEnv } from './env';
import { REFRESH_TOKEN_KEY } from './google/oauth';
import { DbTokenStore, MemoryTokenStore } from './secrets/token-store';

const CRON_SECRET = 'cron-secret-0123456789abcdef';
const KEY = Buffer.alloc(32, 7).toString('base64');

describe('/cron/tick', () => {
  it('requires the bearer secret and runs the heartbeat', async () => {
    let ticks = 0;
    const env = await makeTestEnv([], undefined, {
      cron: { secret: CRON_SECRET, tick: async () => ({ ran: ++ticks }) },
    });
    expect((await env.app.request('/cron/tick')).status).toBe(401);
    const wrong = await env.app.request('/cron/tick', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
    expect(ticks).toBe(0);

    const ok = await env.app.request('/cron/tick', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ran: 1 });
  });

  it('is absent without a configured secret', async () => {
    const env = await makeTestEnv([]);
    const res = await env.app.request('/cron/tick', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('SyncScheduler.runDue', () => {
  it('runs sources that are due and skips ones scheduled later', async () => {
    const env = await makeTestEnv([fakeSource('sync/pages.json')]);
    expect(await env.scheduler.runDue()).toEqual({
      fake: expect.objectContaining({ ok: true }),
    });
    // The interval has not passed yet.
    expect(await env.scheduler.runDue()).toEqual({});
    env.advance(24 * 3_600_000);
    expect(Object.keys(await env.scheduler.runDue())).toEqual(['fake']);
  });
});

describe('live updates on serverless', () => {
  it('declines the event stream with 204 so the web UI polls', async () => {
    const env = await makeTestEnv([], undefined, { streaming: false });
    const res = await env.app.request('/api/stream');
    expect(res.status).toBe(204);
  });
});

describe('webhooks on serverless', () => {
  it('hands message processing to `background` so it outlives the response', async () => {
    const kept: Promise<unknown>[] = [];
    const h = await inboundHarness({ background: (work) => void kept.push(work) });
    const res = await h.postTelegram(ownerUpdate('help'));
    expect(res.status).toBe(200);
    expect(kept).toHaveLength(1);
    await Promise.all(kept);
    expect(h.telegramReplies().at(-1)).toMatch(/./);
  });
});

describe('DbTokenStore', () => {
  it('stores only ciphertext and round-trips', async () => {
    const env = await makeTestEnv([]);
    const store = new DbTokenStore(env.db, KEY, env.now);
    expect(await store.get(REFRESH_TOKEN_KEY)).toBeNull();
    await store.set(REFRESH_TOKEN_KEY, 'refresh-token-value');
    expect(await store.get(REFRESH_TOKEN_KEY)).toBe('refresh-token-value');
    const rows = await env.db.select().from(secrets).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).not.toContain('refresh-token-value');
    // A different key cannot read it.
    await expect(
      new DbTokenStore(env.db, Buffer.alloc(32, 9).toString('base64')).get(REFRESH_TOKEN_KEY),
    ).rejects.toThrow();
    await store.delete(REFRESH_TOKEN_KEY);
    expect(await store.get(REFRESH_TOKEN_KEY)).toBeNull();
  });
});

describe('Connect Google (browser flow)', () => {
  async function setup() {
    const tokenStore = new MemoryTokenStore();
    let connected = 0;
    const google = fakeFetch(() => ({ status: 200, json: { refresh_token: 'rt-123' } }));
    const env = await makeTestEnv([], undefined, {
      google: {
        client: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh' },
        tokenStore,
        publicOrigin: 'https://planner.example.com',
        onConnected: async () => void connected++,
        fetch: google,
      },
    });
    return { env, tokenStore, google, connected: () => connected };
  }

  it('redirects to Google with PKCE and a state cookie, then stores the refresh token', async () => {
    const s = await setup();
    const start = await s.env.app.request('/api/google/connect');
    expect(start.status).toBe(302);
    const auth = new URL(start.headers.get('location')!);
    expect(auth.origin).toBe('https://accounts.google.com');
    expect(auth.searchParams.get('redirect_uri')).toBe(
      'https://planner.example.com/api/google/callback',
    );
    expect(auth.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/calendar.readonly',
    );
    const cookie = start.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    const flow = cookie.split(';')[0]!;
    const state = auth.searchParams.get('state')!;

    const done = await s.env.app.request(`/api/google/callback?state=${state}&code=abc`, {
      headers: { cookie: flow },
    });
    expect(done.headers.get('location')).toBe('/#/settings?google=connected');
    expect(await s.tokenStore.get(REFRESH_TOKEN_KEY)).toBe('rt-123');
    expect(s.google.calls[0]!.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'abc',
      redirect_uri: 'https://planner.example.com/api/google/callback',
    });
    await Promise.resolve();
    expect(s.connected()).toBe(1);
  });

  it('rejects a callback whose state does not match the cookie', async () => {
    const s = await setup();
    const start = await s.env.app.request('/api/google/connect');
    const flow = start.headers.get('set-cookie')!.split(';')[0]!;
    const res = await s.env.app.request('/api/google/callback?state=forged&code=abc', {
      headers: { cookie: flow },
    });
    expect(res.headers.get('location')).toBe('/#/settings?google=expired');
    expect(s.google.calls).toHaveLength(0);
    expect(await s.tokenStore.get(REFRESH_TOKEN_KEY)).toBeNull();
  });
});

describe('env on Vercel', () => {
  const base = {
    VERCEL: '1',
    NODE_ENV: 'production',
    AUTH_MODE: 'password',
    AUTH_PASSWORD_HASH: 'scrypt$32768$8$1$a$b',
    SESSION_SECRET: 'x'.repeat(32),
    PUBLIC_BASE_URL: 'https://planner.example.com',
    TOKEN_ENCRYPTION_KEY: KEY,
  };

  it('requires a hosted database, a cron secret, and Telegram in webhook mode', () => {
    expect(() => loadEnv(base)).toThrow(/TURSO_DATABASE_URL.*CRON_SECRET/);
    const ok = {
      ...base,
      TURSO_DATABASE_URL: 'libsql://planner.turso.io',
      CRON_SECRET,
    };
    expect(loadEnv(ok).VERCEL).toBe('1');
    expect(() => loadEnv({ ...ok, TELEGRAM_BOT_TOKEN: '1:abc' })).toThrow(
      /TELEGRAM_MODE.*TELEGRAM_WEBHOOK_SECRET/,
    );
    expect(
      loadEnv({
        ...ok,
        TELEGRAM_BOT_TOKEN: '1:abc',
        TELEGRAM_MODE: 'webhook',
        TELEGRAM_WEBHOOK_SECRET: 'w'.repeat(24),
      }).TELEGRAM_MODE,
    ).toBe('webhook');
  });
});
