import { createHash, randomBytes } from 'node:crypto';
import type { TokenStore } from '../secrets/token-store';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** Calendar events read/write + Google Tasks (used by inbound capture). Not full `calendar`. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks',
];

export const REFRESH_TOKEN_KEY = 'google.refresh_token';

export type FetchFn = typeof fetch;

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
}

export class GoogleAuthError extends Error {}

const b64url = (b: Buffer) => b.toString('base64url');

export function createPkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string[];
}): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.search = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: (opts.scopes ?? GOOGLE_SCOPES).join(' '),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    // Always re-consent so Google returns a refresh token.
    prompt: 'consent',
  }).toString();
  return u.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

async function postToken(fetchFn: FetchFn, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    // Only the OAuth error code is surfaced; bodies are never logged.
    throw new GoogleAuthError(`token endpoint ${res.status}: ${json.error ?? 'unknown_error'}`);
  }
  return json;
}

export async function exchangeCode(
  fetchFn: FetchFn,
  cfg: GoogleClientConfig,
  opts: { code: string; codeVerifier: string; redirectUri: string },
) {
  const json = await postToken(fetchFn, {
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: opts.redirectUri,
  });
  if (!json.refresh_token) throw new GoogleAuthError('Google did not return a refresh token');
  return { refreshToken: json.refresh_token };
}

export interface AccessTokenProvider {
  accessToken(): Promise<string>;
  /** Drop the cached access token (after a 401). */
  invalidate(): void;
}

/** Exchanges the stored refresh token for short-lived access tokens, cached until near expiry. */
export class GoogleAuth implements AccessTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: GoogleClientConfig,
    private readonly store: TokenStore,
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.token;
    const refreshToken = await this.store.get(REFRESH_TOKEN_KEY);
    if (!refreshToken) {
      throw new GoogleAuthError('Google is not connected: run `npm run auth:google`');
    }
    let json: TokenResponse;
    try {
      json = await postToken(this.fetchFn, {
        grant_type: 'refresh_token',
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: refreshToken,
      });
    } catch (e) {
      if (e instanceof GoogleAuthError && e.message.includes('invalid_grant')) {
        throw new GoogleAuthError(
          'Google refresh token was rejected (expired or revoked): run `npm run auth:google`',
        );
      }
      throw e;
    }
    if (!json.access_token) throw new GoogleAuthError('token endpoint returned no access_token');
    // Refresh a minute early.
    const ttl = Math.max(0, (json.expires_in ?? 3600) - 60) * 1000;
    this.cached = { token: json.access_token, expiresAt: this.now() + ttl };
    return json.access_token;
  }

  invalidate() {
    this.cached = null;
  }
}
