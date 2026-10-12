import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import type { AppDeps } from '../app';
import {
  buildAuthUrl,
  createPkce,
  exchangeCode,
  REFRESH_TOKEN_KEY,
  type FetchFn,
  type GoogleClientConfig,
} from '../google/oauth';
import { log, sanitizeError } from '../log';
import type { TokenStore } from '../secrets/token-store';

const FLOW_COOKIE = 'planner_google_oauth';
const FLOW_TTL_SEC = 10 * 60;
export const GOOGLE_CALLBACK_PATH = '/api/google/callback';

export interface GoogleConnectDeps {
  client: GoogleClientConfig;
  tokenStore: TokenStore;
  /** https origin Google redirects back to; defaults to the request's origin (local dev). */
  publicOrigin?: string;
  /** Runs after a successful connection (e.g. start the first calendar sync). */
  onConnected?: () => Promise<unknown>;
  fetch?: FetchFn;
}

const back = (status: string) => `/#/settings?google=${status}`;

/**
 * Browser-based Google sign-in (Web application OAuth client, PKCE). Both routes sit behind the
 * app's login; the state and PKCE verifier live in a short-lived httpOnly cookie. Only the
 * refresh token is stored, encrypted. Scope is calendar.readonly.
 */
export function googleRoutes({ google, background }: AppDeps) {
  const app = new Hono();

  app.get('/connect', (c) => {
    if (!google) return c.json({ error: 'google_not_configured' }, 503);
    const origin = google.publicOrigin ?? new URL(c.req.url).origin;
    const { verifier, challenge } = createPkce();
    const state = randomBytes(16).toString('base64url');
    setCookie(c, FLOW_COOKIE, `${state}.${verifier}`, {
      httpOnly: true,
      secure: origin.startsWith('https://'),
      sameSite: 'Lax',
      path: '/api/google',
      maxAge: FLOW_TTL_SEC,
    });
    return c.redirect(
      buildAuthUrl({
        clientId: google.client.clientId,
        redirectUri: origin + GOOGLE_CALLBACK_PATH,
        state,
        codeChallenge: challenge,
      }),
      302,
    );
  });

  app.get('/callback', async (c) => {
    if (!google) return c.json({ error: 'google_not_configured' }, 503);
    const origin = google.publicOrigin ?? new URL(c.req.url).origin;
    const [state, verifier] = (getCookie(c, FLOW_COOKIE) ?? '').split('.');
    deleteCookie(c, FLOW_COOKIE, { path: '/api/google' });
    const code = c.req.query('code');
    if (!state || !verifier || c.req.query('state') !== state) return c.redirect(back('expired'));
    if (c.req.query('error') || !code) return c.redirect(back('denied'));
    try {
      const { refreshToken } = await exchangeCode(google.fetch ?? fetch, google.client, {
        code,
        codeVerifier: verifier,
        redirectUri: origin + GOOGLE_CALLBACK_PATH,
      });
      await google.tokenStore.set(REFRESH_TOKEN_KEY, refreshToken);
    } catch (e) {
      log.warn('google connect failed', { error: sanitizeError(e) });
      return c.redirect(back('failed'));
    }
    log.info('google connected', { tokenStore: google.tokenStore.kind });
    if (google.onConnected) {
      const first = google
        .onConnected()
        .catch((e) => log.warn('first google sync failed', { error: sanitizeError(e) }));
      if (background) background(first);
      else void first;
    }
    return c.redirect(back('connected'));
  });

  return app;
}
