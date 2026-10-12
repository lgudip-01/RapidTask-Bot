import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { log, sanitizeError } from '../log';
import { verifyPassword, signSession } from '../security/auth';
import { ipRateLimit, SESSION_COOKIE, type SecurityConfig } from '../security/middleware';

/** Only same-site relative paths are allowed after login. */
const safeNext = (n: string | undefined) => (n && /^\/(?!\/)[\w\-./#?=&%]*$/.test(n) ? n : '/');

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

type LoginError = { text: string; field: boolean };

/** Why the last sign-in failed (`?e=`). Every failure comes back to this page. */
function loginError(code: string | undefined, publicOrigin: string | undefined): LoginError | null {
  switch (code) {
    case undefined:
    case '':
      return null;
    case 'locked':
      return { text: 'Too many attempts. Wait 15 minutes, then try again.', field: false };
    case 'origin':
      return {
        text: publicOrigin
          ? `Please sign in at ${publicOrigin}.`
          : 'This sign-in came from a different site. Reload the page and try again.',
        field: false,
      };
    case 'config':
      return {
        text: "Sign-in isn't set up correctly on the server (AUTH_PASSWORD_HASH). Check the logs.",
        field: false,
      };
    default:
      return { text: 'Wrong password. Please try again.', field: true };
  }
}

/** Show/hide and "Signing in…" (served as a file: the CSP allows no inline scripts). */
const LOGIN_JS = `(() => {
  const pw = document.getElementById('pw');
  const toggle = document.getElementById('toggle');
  const form = document.querySelector('form');
  const btn = document.getElementById('submit');
  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(show));
    pw.focus();
  });
  pw.addEventListener('input', () => {
    pw.removeAttribute('aria-invalid');
    const e = document.getElementById('err');
    if (e && e.dataset.field) e.hidden = true;
  });
  form.addEventListener('submit', () => {
    btn.disabled = true;
    btn.textContent = 'Signing in…';
  });
})();
`;

const page = (error: LoginError | null, next: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#121212">
<title>Sign in · Planner</title>
<style>
:root{color-scheme:dark;--bg:#121212;--s:#1a1a19;--l:#2e2e2b;--t:#ececea;--m:#a3a39c;--a:#733001;--ai:#d9a27c;--d:#fb923c;--ds:#2a1b12}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--t);font:15px/1.4 Inter,system-ui,sans-serif;padding:16px}
form{width:100%;max-width:360px;background:var(--s);border:1px solid var(--l);border-radius:16px;padding:28px 24px 22px;box-shadow:0 8px 24px rgb(0 0 0/.06);animation:in .35s ease-out}
@keyframes in{from{opacity:0;transform:translateY(8px)}}
@keyframes shake{20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
.logo{width:36px;height:36px;border-radius:10px;background:var(--a);color:#fff;display:grid;place-items:center;font-weight:700;margin-bottom:14px}
h1{font-size:19px;margin:0 0 4px}p{margin:0 0 18px;color:var(--m);font-size:13px}
label{font-size:12px;font-weight:500;color:var(--m)}
.field{position:relative;margin-top:6px}
input[type=password],input[type=text]{width:100%;height:42px;border:1px solid var(--l);border-radius:10px;padding:0 64px 0 12px;background:var(--bg);color:var(--t);font-size:15px}
input[aria-invalid=true]{border-color:var(--d);animation:shake .35s}
#toggle{position:absolute;right:6px;top:6px;height:30px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--m);font-size:12px;font-weight:600;cursor:pointer}
#toggle:hover{color:var(--t);background:var(--l)}
input:focus-visible,button:focus-visible{outline:2px solid var(--ai);outline-offset:2px}
#submit{margin-top:16px;width:100%;height:42px;border:0;border-radius:10px;background:var(--a);color:#fff;font-weight:600;font-size:14px;cursor:pointer}
#submit:disabled{opacity:.7;cursor:progress}
.e{margin-top:12px;padding:8px 10px;border-radius:8px;background:var(--ds);color:var(--d);font-size:13px}
details{margin-top:16px;font-size:12px;color:var(--m)}summary{cursor:pointer}
details p{margin:6px 0 0;font-size:12px}code{font-size:11px;background:var(--bg);padding:1px 4px;border-radius:4px}
@media(prefers-reduced-motion:reduce){form,input[aria-invalid=true]{animation:none}}
</style></head><body>
<form method="post" action="/auth/login" novalidate>
<div class="logo" aria-hidden="true">P</div>
<h1>Welcome back</h1><p>Sign in to your Planner.</p>
<label for="pw">Password</label>
<div class="field">
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus${error?.field ? ' aria-invalid="true" aria-describedby="err"' : ''}>
<button type="button" id="toggle" aria-controls="pw" aria-pressed="false" hidden>Show</button>
</div>
<input type="hidden" name="next" value="${esc(next)}">
${error ? `<div class="e" id="err" role="alert"${error.field ? ' data-field="1"' : ''}>${esc(error.text)}</div>` : ''}
<button type="submit" id="submit">Sign in</button>
<details><summary>Forgot your password?</summary>
<p>Planner has one account, so there's no reset email. On your computer run <code>npm run -s hash-password -w @planner/server</code>, then put the result in the <code>AUTH_PASSWORD_HASH</code> environment variable and redeploy.</p>
</details>
</form>
<script src="/auth/login.js" defer></script>
</body></html>`;

export function authRoutes(security: SecurityConfig) {
  const app = new Hono();
  const auth = security.auth;
  const secure = Boolean(security.publicOrigin?.startsWith('https://'));

  app.get('/login', (c) => {
    if (auth.mode !== 'password') return c.redirect('/', 302);
    return c.html(
      page(loginError(c.req.query('e'), security.publicOrigin), safeNext(c.req.query('next'))),
    );
  });

  app.get('/auth/login.js', (c) =>
    c.body(LOGIN_JS, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    }),
  );

  app.post(
    '/auth/login',
    // Brute-force guard: 5 attempts per 15 minutes per IP.
    ipRateLimit({
      limit: 5,
      windowMs: 15 * 60_000,
      trustProxy: security.trustProxy,
      name: 'login',
      now: security.now,
      onLimited: (c) => c.redirect('/login?e=locked', 303),
    }),
    async (c) => {
      if (auth.mode !== 'password') return c.json({ error: 'password_login_disabled' }, 404);
      const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      const password = typeof form.password === 'string' ? form.password : '';
      const next = safeNext(typeof form.next === 'string' ? form.next : undefined);
      const again = (code: string) =>
        c.redirect(`/login?e=${code}&next=${encodeURIComponent(next)}`, 303);
      let ok: boolean;
      try {
        ok =
          Boolean(password) &&
          password.length <= 1024 &&
          (await verifyPassword(password, auth.passwordHash));
      } catch (e) {
        // A malformed AUTH_PASSWORD_HASH: say so instead of failing with a blank error page.
        log.error('password check failed', { error: sanitizeError(e) });
        return again('config');
      }
      if (!ok) return again('1');
      setCookie(
        c,
        SESSION_COOKIE,
        signSession(auth.sessionSecret, auth.sessionTtlMs, security.now?.()),
        {
          httpOnly: true,
          secure,
          sameSite: 'Lax',
          path: '/',
          maxAge: Math.floor(auth.sessionTtlMs / 1000),
        },
      );
      return c.redirect(next, 303);
    },
  );

  app.post('/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure });
    return c.redirect('/login', 303);
  });

  return app;
}
