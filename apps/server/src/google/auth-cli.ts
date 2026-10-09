/**
 * One-time Google OAuth (Desktop client, loopback redirect + PKCE). Stores only the refresh
 * token, in the OS keyring or the encrypted token file. Never prints tokens.
 *
 *   npm run auth:google            connect
 *   npm run auth:google -- --logout  revoke and forget the stored token
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadEnv } from '../env';
import { sanitizeError } from '../log';
import { createTokenStore } from '../secrets/token-store';
import {
  buildAuthUrl,
  createPkce,
  exchangeCode,
  GOOGLE_REVOKE_URL,
  REFRESH_TOKEN_KEY,
} from './oauth';

const TIMEOUT_MS = 5 * 60_000;

function openBrowser(url: string) {
  // Argument arrays only: never pass the URL through a shell.
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // The URL is printed too.
  }
}

const page = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>Planner</title><body style="font:16px system-ui;padding:3rem">${msg}</body>`;

async function main() {
  const env = loadEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
  }
  const cfg = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  const store = await createTokenStore(env);

  if (process.argv.includes('--logout')) {
    const token = await store.get(REFRESH_TOKEN_KEY);
    if (token) {
      await fetch(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      }).catch(() => undefined);
      await store.delete(REFRESH_TOKEN_KEY);
    }
    console.warn(`Google disconnected (${store.kind} store cleared).`);
    return;
  }

  const { verifier, challenge } = createPkce();
  const state = randomBytes(16).toString('base64url');

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer();
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for the Google redirect.'));
    }, TIMEOUT_MS);
    const finish = (err?: Error) => {
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve();
    };

    server.on('request', async (req, res) => {
      const { port } = server.address() as AddressInfo;
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/html' }).end(page('State mismatch. Try again.'));
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error || !code) {
        res
          .writeHead(400, { 'content-type': 'text/html' })
          .end(page('Authorization was not granted.'));
        finish(new Error(`Google returned: ${error ?? 'no code'}`));
        return;
      }
      try {
        const { refreshToken } = await exchangeCode(fetch, cfg, {
          code,
          codeVerifier: verifier,
          redirectUri: `http://127.0.0.1:${port}`,
        });
        await store.set(REFRESH_TOKEN_KEY, refreshToken);
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end(page('Planner is connected to Google. You can close this tab.'));
        finish();
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/html' }).end(page('Token exchange failed.'));
        finish(e as Error);
      }
    });

    // Loopback only, ephemeral port (Desktop clients accept any 127.0.0.1 port).
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const authUrl = buildAuthUrl({
        clientId: cfg.clientId,
        redirectUri: `http://127.0.0.1:${port}`,
        state,
        codeChallenge: challenge,
      });
      console.warn(
        `Opening your browser to authorize Planner.\nIf it does not open, visit:\n\n${authUrl}\n`,
      );
      openBrowser(authUrl);
    });
  });

  console.warn(`Connected. Refresh token stored in the ${store.kind} token store.`);
}

main().catch((e: Error) => {
  console.error(`auth:google failed: ${sanitizeError(e)}`);
  process.exit(1);
});
