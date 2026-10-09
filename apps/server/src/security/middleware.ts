import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { SlidingWindowLimiter } from '../inbound/rate-limit';
import { log } from '../log';
import { verifySession } from './auth';

export type AuthConfig =
  | { mode: 'none' }
  | { mode: 'password'; passwordHash: string; sessionSecret: string; sessionTtlMs: number }
  | { mode: 'cloudflare'; verify: (token: string | undefined) => Promise<boolean> };

export interface SecurityConfig {
  auth: AuthConfig;
  /** https origin of the deployment; enables the same-origin check, CORS allowlist, and HSTS. */
  publicOrigin?: string;
  /** Trust Fly-Client-IP / X-Forwarded-* (only behind a proxy that sets them). */
  trustProxy: boolean;
  webhookRateLimitPerMin: number;
  now?: () => number;
}

/** Paths reachable without a session. Webhooks authenticate with provider signatures instead. */
export const PUBLIC_PATHS = [/^\/webhooks\//, /^\/healthz$/, /^\/login$/, /^\/auth\/login$/];
const isPublic = (path: string) => PUBLIC_PATHS.some((re) => re.test(path));

export const SESSION_COOKIE = 'planner_session';

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const fly = c.req.header('fly-client-ip');
    if (fly) return fly;
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0]!.trim();
  }
  // Direct connection (dev); good enough as a rate-limit key.
  return (
    (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket
      ?.remoteAddress ?? 'unknown'
  );
}

export function securityHeaders(publicOrigin?: string): MiddlewareHandler {
  return secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      // Motion animates via inline style attributes.
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
    strictTransportSecurity: publicOrigin?.startsWith('https://')
      ? 'max-age=63072000; includeSubDomains'
      : false,
    // Not "no-referrer": that makes browsers send `Origin: null` on our own form posts.
    referrerPolicy: 'same-origin',
    xFrameOptions: 'DENY',
    crossOriginResourcePolicy: 'same-origin',
    permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [] },
  });
}

/** Behind a TLS-terminating proxy: plain-http requests are redirected (GET) or refused. */
export function httpsOnly(trustProxy: boolean): MiddlewareHandler {
  return async (c, next) => {
    if (trustProxy && c.req.header('x-forwarded-proto') === 'http') {
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('HTTPS required', 403);
      const url = new URL(c.req.url);
      url.protocol = 'https:';
      return c.redirect(url.toString(), 301);
    }
    await next();
  };
}

/**
 * Same-origin guard for state-changing requests (CSRF defense on top of SameSite cookies):
 * the Origin header must match the deployment, or the browser must say same-origin.
 */
export function sameOriginWrites(publicOrigin?: string): MiddlewareHandler {
  return async (c, next) => {
    const m = c.req.method;
    if (
      m === 'GET' ||
      m === 'HEAD' ||
      m === 'OPTIONS' ||
      (isPublic(c.req.path) && c.req.path !== '/auth/login')
    ) {
      return next();
    }
    const origin = c.req.header('origin');
    const site = c.req.header('sec-fetch-site');
    const expected = publicOrigin ?? new URL(c.req.url).origin;
    // An opaque `Origin: null` (privacy-sensitive contexts) falls back to Fetch Metadata.
    const ok =
      origin && origin !== 'null'
        ? origin === expected
        : origin === 'null'
          ? site === 'same-origin'
          : site === 'same-origin' || site === 'none' || site === undefined;
    if (!ok) return c.json({ error: 'cross_origin_forbidden' }, 403);
    await next();
  };
}

export function requireAuth(auth: AuthConfig, now: () => number = Date.now): MiddlewareHandler {
  return async (c, next) => {
    if (auth.mode === 'none' || isPublic(c.req.path)) return next();
    const ok =
      auth.mode === 'password'
        ? verifySession(auth.sessionSecret, getCookie(c, SESSION_COOKIE), now())
        : await auth.verify(c.req.header('cf-access-jwt-assertion'));
    if (ok) return next();
    if (c.req.path.startsWith('/api/') || auth.mode === 'cloudflare') {
      return c.json({ error: 'unauthorized' }, auth.mode === 'cloudflare' ? 403 : 401);
    }
    const next_ = encodeURIComponent(c.req.path);
    return c.redirect(`/login?next=${next_}`, 302);
  };
}

/** Fixed-window-ish per-IP limiter returning 429 with Retry-After. */
export function ipRateLimit(opts: {
  limit: number;
  windowMs: number;
  trustProxy: boolean;
  name: string;
  now?: () => number;
}): MiddlewareHandler {
  const limiter = new SlidingWindowLimiter(opts.limit, opts.windowMs, opts.now);
  let lastLog = 0;
  return async (c, next) => {
    if (!limiter.allow(clientIp(c, opts.trustProxy))) {
      const t = (opts.now ?? Date.now)();
      if (t - lastLog > 60_000) {
        lastLog = t;
        log.warn('rate limited', { route: opts.name });
      }
      c.header('Retry-After', String(Math.ceil(opts.windowMs / 1000)));
      return c.json({ error: 'rate_limited' }, 429);
    }
    await next();
  };
}
