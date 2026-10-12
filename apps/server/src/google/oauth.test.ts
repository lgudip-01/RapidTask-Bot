import { describe, expect, it } from 'vitest';
import { fakeFetch } from '../../test/fake-fetch';
import { MemoryTokenStore } from '../secrets/token-store';
import {
  buildAuthUrl,
  createPkce,
  exchangeCode,
  GOOGLE_SCOPES,
  GoogleAuth,
  REFRESH_TOKEN_KEY,
} from './oauth';

const cfg = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret' };

describe('Google OAuth', () => {
  it('builds a PKCE, offline, consent auth URL with narrow scopes', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[\w-]{43}$/);
    const u = new URL(
      buildAuthUrl({
        clientId: cfg.clientId,
        redirectUri: 'http://127.0.0.1:5555',
        state: 's1',
        codeChallenge: challenge,
      }),
    );
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: cfg.clientId,
      redirect_uri: 'http://127.0.0.1:5555',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      state: 's1',
      scope: GOOGLE_SCOPES.join(' '),
    });
    expect(u.searchParams.get('scope')).not.toContain('auth/calendar ');
  });

  it('exchanges a code with the PKCE verifier', async () => {
    const api = fakeFetch(() => ({
      status: 200,
      json: { access_token: 'at', refresh_token: 'rt', expires_in: 3599 },
    }));
    const res = await exchangeCode(api, cfg, {
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'http://127.0.0.1:1',
    });
    expect(res).toEqual({ refreshToken: 'rt' });
    expect(api.calls[0]!.body).toMatchObject({
      grant_type: 'authorization_code',
      code_verifier: 'v',
    });
  });

  it('caches access tokens until shortly before expiry', async () => {
    let t = 0;
    const store = new MemoryTokenStore();
    await store.set(REFRESH_TOKEN_KEY, 'rt');
    let n = 0;
    const api = fakeFetch(() => ({
      status: 200,
      json: { access_token: `at${++n}`, expires_in: 3600 },
    }));
    const auth = new GoogleAuth(cfg, store, api, () => t);

    expect(await auth.accessToken()).toBe('at1');
    t = 3_500_000;
    expect(await auth.accessToken()).toBe('at1');
    t = 3_550_000; // inside the 60 s safety margin
    expect(await auth.accessToken()).toBe('at2');
    auth.invalidate();
    expect(await auth.accessToken()).toBe('at3');
    expect(api.calls[0]!.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt' });
  });

  it('explains how to reconnect when the refresh token is missing or revoked, without echoing it', async () => {
    const store = new MemoryTokenStore();
    const api = fakeFetch(() => ({
      status: 400,
      json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
    }));
    const auth = new GoogleAuth(cfg, store, api);
    await expect(auth.accessToken()).rejects.toThrow(/Connect Google/);

    await store.set(REFRESH_TOKEN_KEY, '1//super-secret-refresh');
    const err = await auth.accessToken().catch((e: Error) => e);
    expect((err as Error).message).toMatch(/expired or revoked.*Connect Google/);
    expect((err as Error).message).not.toContain('super-secret');
  });
});
