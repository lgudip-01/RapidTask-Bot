import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTestEnv } from '../../test/helpers';
import { exportData } from '../backup/backup';
import { loadEnv } from '../env';
import { sanitizeError } from '../log';
import { hashPassword, signSession, verifyPassword, verifySession } from './auth';
import type { SecurityConfig } from './middleware';

const ORIGIN = 'https://planner.example.com';
const PASSWORD = 'correct horse battery staple';
const SECRET = 's'.repeat(40);
const hash = await hashPassword(PASSWORD);

async function env(over: Partial<SecurityConfig> = {}, webDist?: string) {
  let t = Date.parse('2026-10-09T16:00:00Z');
  const security: SecurityConfig = {
    auth: { mode: 'password', passwordHash: hash, sessionSecret: SECRET, sessionTtlMs: 86_400_000 },
    publicOrigin: ORIGIN,
    trustProxy: true,
    webhookRateLimitPerMin: 5,
    now: () => t,
    ...over,
  };
  const e = await makeTestEnv([], '2026-10-09T16:00:00.000Z', { security, webDist });
  const req = (url: string, init: RequestInit & { ip?: string } = {}) =>
    e.app.request(url, {
      ...init,
      headers: {
        'fly-client-ip': init.ip ?? '203.0.113.7',
        ...(init.headers as Record<string, string>),
      },
    });
  const login = (password: string, ip?: string) =>
    req('/auth/login', {
      method: 'POST',
      ip,
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password, next: '/#/tasks' }).toString(),
    });
  const cookieFrom = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;
  return { ...e, req, login, cookieFrom, advance: (ms: number) => (t += ms) };
}

describe('password login', () => {
  it('protects the UI and API, and logs in with the right password', async () => {
    const e = await env();
    const page = await e.req('/');
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/login?next=%2F');
    expect((await e.req('/api/tasks')).status).toBe(401);
    expect((await e.req('/login')).status).toBe(200);

    const bad = await e.login('nope');
    expect(bad.status).toBe(303);
    expect(bad.headers.get('location')).toContain('/login?e=1');
    expect(bad.headers.get('set-cookie')).toBeNull();

    const ok = await e.login(PASSWORD);
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/#/tasks');
    const setCookie = ok.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    expect((await e.req('/api/tasks', { headers: { cookie: e.cookieFrom(ok) } })).status).toBe(200);
  });

  it('sends every failed sign-in back to the form with a message', async () => {
    const e = await env();
    const text = async (url: string) => (await e.req(url)).text();
    expect(await text('/login')).not.toContain('role="alert"');

    const bad = await e.login('nope');
    const page = await text(bad.headers.get('location')!);
    expect(page).toContain('Wrong password. Please try again.');
    expect(page).toContain('name="password"'); // the form is shown again, empty

    // Posted from another address (e.g. a Vercel preview URL that is not PUBLIC_BASE_URL).
    const other = await e.req('/auth/login', {
      method: 'POST',
      headers: {
        origin: 'https://rapid-task-preview.vercel.app',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ password: PASSWORD }).toString(),
    });
    expect(other.status).toBe(303);
    expect(other.headers.get('set-cookie')).toBeNull();
    expect(await text(other.headers.get('location')!)).toContain(`Sign in at ${ORIGIN}`);
  });

  it('explains a malformed password hash instead of failing', async () => {
    const e = await env({
      auth: {
        mode: 'password',
        passwordHash: 'scrypt$x$8$1$c2FsdA$aGFzaA',
        sessionSecret: SECRET,
        sessionTtlMs: 86_400_000,
      },
    });
    const res = await e.login(PASSWORD);
    expect(res.headers.get('location')).toContain('/login?e=config');
  });

  it('rejects tampered and expired sessions', async () => {
    const e = await env();
    const cookie = e.cookieFrom(await e.login(PASSWORD));
    const tampered = cookie.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'));
    expect((await e.req('/api/tasks', { headers: { cookie: tampered } })).status).toBe(401);
    e.advance(86_400_001);
    expect((await e.req('/api/tasks', { headers: { cookie } })).status).toBe(401);
  });

  it('only redirects to same-site paths after login', async () => {
    const e = await env();
    const res = await e.req('/auth/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: PASSWORD, next: '//evil.example.com' }).toString(),
    });
    expect(res.headers.get('location')).toBe('/');
  });

  it('rate limits login attempts per IP', async () => {
    const e = await env();
    for (let i = 0; i < 5; i++) expect((await e.login('wrong')).status).toBe(303);
    const blocked = await e.login(PASSWORD);
    // Back to the sign-in page with an explanation, and no session.
    expect(blocked.status).toBe(303);
    expect(blocked.headers.get('location')).toBe('/login?e=locked');
    expect(blocked.headers.get('set-cookie')).toBeNull();
    expect(blocked.headers.get('retry-after')).toBe('900');
    expect(await (await e.req('/login?e=locked')).text()).toContain('Too many attempts');
    expect((await e.login(PASSWORD, '198.51.100.9')).status).toBe(303); // other IP unaffected
  });

  it('logout clears the cookie', async () => {
    const e = await env();
    const cookie = e.cookieFrom(await e.login(PASSWORD));
    const out = await e.req('/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: ORIGIN },
    });
    expect(out.status).toBe(303);
    expect(out.headers.get('set-cookie')).toMatch(/planner_session=;/);
  });
});

describe('public routes and hardening', () => {
  it('keeps /health and /webhooks/* reachable without a session', async () => {
    const e = await env();
    expect(await (await e.req('/health')).json()).toEqual({ ok: true });
    // No channel configured → 404, but crucially not 401/302.
    expect((await e.req('/webhooks/telegram', { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('rate limits webhooks per IP', async () => {
    const e = await env();
    const codes = [];
    for (let i = 0; i < 7; i++)
      codes.push((await e.req('/webhooks/twilio', { method: 'POST', body: 'x' })).status);
    expect(codes.slice(0, 5).every((c) => c === 404)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it('sends security headers', async () => {
    const res = await (await env()).req('/health');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('strict-transport-security')).toContain('max-age=63072000');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('redirects plain http to https behind the proxy', async () => {
    const res = await (await env()).req('/health', { headers: { 'x-forwarded-proto': 'http' } });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toMatch(/^https:/);
  });

  it('blocks cross-origin writes and only allows CORS for the deployment origin', async () => {
    const e = await env();
    const cookie = e.cookieFrom(await e.login(PASSWORD));
    const post = (origin: string) =>
      e.req('/api/tasks', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'x' }),
      });
    expect((await post('https://evil.example.com')).status).toBe(403);
    expect((await post(ORIGIN)).status).toBe(201);

    // Browsers may send an opaque Origin; then Fetch Metadata decides.
    const nullOrigin = (site: string) =>
      e.req('/api/tasks', {
        method: 'POST',
        headers: {
          cookie,
          origin: 'null',
          'sec-fetch-site': site,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'y' }),
      });
    expect((await nullOrigin('same-origin')).status).toBe(201);
    expect((await nullOrigin('cross-site')).status).toBe(403);

    const preflight = (origin: string) =>
      e.req('/api/tasks', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
    expect(
      (await preflight('https://evil.example.com')).headers.get('access-control-allow-origin'),
    ).toBeNull();
    expect((await preflight(ORIGIN)).headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('cloudflare mode requires a valid Access assertion', async () => {
    const e = await env({ auth: { mode: 'cloudflare', verify: async (t) => t === 'valid-jwt' } });
    // API: 401 without valid credentials (same as password mode); pages: 403 (no login page).
    expect((await e.req('/api/tasks')).status).toBe(401);
    expect(
      (await e.req('/api/tasks', { headers: { 'cf-access-jwt-assertion': 'forged' } })).status,
    ).toBe(401);
    expect((await e.req('/week')).status).toBe(403);
    expect(
      (await e.req('/api/tasks', { headers: { 'cf-access-jwt-assertion': 'valid-jwt' } })).status,
    ).toBe(200);
  });

  it('answers 401 on every /api route without a session, and lets only public paths through', async () => {
    const e = await env();
    for (const url of [
      '/api/agenda?from=2026-10-09T00:00:00Z&to=2026-10-10T00:00:00Z',
      '/api/tasks',
      '/api/events/x',
      '/api/backups',
      '/api/settings',
      '/api/status',
      '/api/stream',
      '/api/me',
    ]) {
      expect([url, (await e.req(url)).status]).toEqual([url, 401]);
    }
    expect(
      (await e.req('/api/tasks', { method: 'POST', headers: { origin: ORIGIN } })).status,
    ).toBe(401);
    expect((await e.req('/health')).status).toBe(200);
  });

  it('rate limits /health per IP', async () => {
    const e = await env({ healthRateLimitPerMin: 3 });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await e.req('/health')).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect((await e.req('/health', { ip: '198.51.100.9' })).status).toBe(200);
  });

  it('serves the built UI with an SPA fallback behind auth', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-web-'));
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
    const e = await env({}, dist);
    const cookie = e.cookieFrom(await e.login(PASSWORD));
    const home = await e.req('/', { headers: { cookie } });
    expect(await home.text()).toContain('id="root"');
    const asset = await e.req('/assets/app-abc123.js', { headers: { cookie } });
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await e.req('/tasks', { headers: { cookie } })).status).toBe(200);
    expect((await e.req('/api/nope', { headers: { cookie } })).status).toBe(404);
    expect((await e.req('/assets/app-abc123.js')).status).toBe(302); // not without a session
  });
});

describe('primitives', () => {
  it('hashes and verifies passwords', async () => {
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'garbage')).toBe(false);
  });

  it('signs sessions that expire', () => {
    const tok = signSession(SECRET, 1000, 0);
    expect(verifySession(SECRET, tok, 999)).toBe(true);
    expect(verifySession(SECRET, tok, 1000)).toBe(false);
    expect(verifySession('other'.repeat(10), tok, 0)).toBe(false);
  });

  it('redacts secrets from errors', () => {
    const s = sanitizeError(
      new Error(
        // All fake values shaped like the real thing.
        'x-api-key sk-ant-api03-ABCdef_123 auth Basic QUM6dG9rZW4= bot 123456789:AAEfakeFAKEfakeFAKEfakeFAKEfake0000 hash scrypt$32768$8$1$a$b ?access_token=abc',
      ),
    );
    for (const leak of [
      'sk-ant-api03',
      'QUM6dG9rZW4',
      'AAEfakeFAKE',
      'scrypt$32768',
      'access_token=abc',
    ]) {
      expect(s).not.toContain(leak);
    }
  });
});

describe('environment guards', () => {
  it('refuses to run in production without auth or https', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(
      /AUTH_MODE.*PUBLIC_BASE_URL|PUBLIC_BASE_URL.*AUTH_MODE/s,
    );
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        AUTH_MODE: 'password',
        PUBLIC_BASE_URL: 'https://x.fly.dev',
        TOKEN_ENCRYPTION_KEY: 'k',
      }),
    ).toThrow(/AUTH_PASSWORD_HASH, SESSION_SECRET/);
    expect(
      loadEnv({
        NODE_ENV: 'production',
        AUTH_MODE: 'password',
        AUTH_PASSWORD_HASH: hash,
        SESSION_SECRET: SECRET,
        PUBLIC_BASE_URL: 'https://x.fly.dev',
        TOKEN_ENCRYPTION_KEY: 'k',
      }).AUTH_MODE,
    ).toBe('password');
  });

  it('never echoes secret values in env errors', () => {
    const err = (() => {
      try {
        loadEnv({
          AUTH_MODE: 'password',
          AUTH_PASSWORD_HASH: 'plaintext-oops',
          SESSION_SECRET: 'short-secret',
        });
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).not.toContain('plaintext-oops');
    expect(err).not.toContain('short-secret');
  });
});

describe('backup', () => {
  it('exports every task as JSON', async () => {
    const e = await makeTestEnv([]);
    await e.json('POST', '/api/tasks', { title: 'Back me up' });
    const out = await exportData(e.db, new Date('2026-10-09T16:00:00Z'));
    expect(out).toMatchObject({ version: 2, count: 1, exportedAt: '2026-10-09T16:00:00.000Z' });
    expect(out.tasks[0]).toMatchObject({ title: 'Back me up', source: 'local' });
  });
});

describe('listen address', () => {
  it('binds to loopback unless told otherwise', () => {
    expect(loadEnv({}).HOST).toBe('127.0.0.1');
  });

  it('refuses a non-loopback HOST without authentication', () => {
    expect(() => loadEnv({ HOST: '0.0.0.0' })).toThrow(/HOST/);
    expect(() => loadEnv({ HOST: '192.168.1.20', AUTH_MODE: 'none' })).toThrow(/HOST/);
    expect(loadEnv({ HOST: '::1' }).HOST).toBe('::1');
    expect(
      loadEnv({
        HOST: '0.0.0.0',
        AUTH_MODE: 'password',
        AUTH_PASSWORD_HASH: hash,
        SESSION_SECRET: SECRET,
      }).HOST,
    ).toBe('0.0.0.0');
  });
});
