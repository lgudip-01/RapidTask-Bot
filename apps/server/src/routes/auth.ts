import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { verifyPassword, signSession } from '../security/auth';
import { ipRateLimit, SESSION_COOKIE, type SecurityConfig } from '../security/middleware';

/** Only same-site relative paths are allowed after login. */
const safeNext = (n: string | undefined) => (n && /^\/(?!\/)[\w\-./#?=&%]*$/.test(n) ? n : '/');

const page = (error: boolean, next: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Planner</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f5;--s:#fff;--l:#e4e4df;--t:#1c1c1a;--m:#6b6b66;--a:#4f46e5;--d:#c2410c}
@media(prefers-color-scheme:dark){:root{--bg:#121212;--s:#1a1a19;--l:#2e2e2b;--t:#ececea;--m:#a3a39c;--a:#8b8cff;--d:#fb923c}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--t);font:15px/1.4 Inter,system-ui,sans-serif;padding:16px}
form{width:100%;max-width:340px;background:var(--s);border:1px solid var(--l);border-radius:16px;padding:24px;box-shadow:0 8px 24px rgb(0 0 0/.06);animation:in .35s ease-out}
@keyframes in{from{opacity:0;transform:translateY(8px)}}@media(prefers-reduced-motion:reduce){form{animation:none}}
h1{font-size:18px;margin:0 0 4px}p{margin:0 0 16px;color:var(--m);font-size:13px}
label{font-size:12px;color:var(--m)}input{width:100%;height:40px;margin-top:4px;border:1px solid var(--l);border-radius:10px;padding:0 12px;background:var(--bg);color:var(--t);font-size:15px}
input:focus-visible,button:focus-visible{outline:2px solid var(--a);outline-offset:2px}
button{margin-top:16px;width:100%;height:40px;border:0;border-radius:10px;background:var(--a);color:#fff;font-weight:600;font-size:14px;cursor:pointer}
.e{color:var(--d);font-size:13px;margin-top:10px}
</style></head><body>
<form method="post" action="/auth/login">
<h1>Planner</h1><p>Sign in to continue.</p>
<label for="pw">Password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="next" value="${next.replace(/"/g, '&quot;')}">
<button type="submit">Sign in</button>
${error ? '<div class="e" role="alert">That password didn\'t work.</div>' : ''}
</form></body></html>`;

export function authRoutes(security: SecurityConfig) {
  const app = new Hono();
  const auth = security.auth;
  const secure = Boolean(security.publicOrigin?.startsWith('https://'));

  app.get('/login', (c) => {
    if (auth.mode !== 'password') return c.redirect('/', 302);
    return c.html(page(c.req.query('e') === '1', safeNext(c.req.query('next'))));
  });

  app.post(
    '/auth/login',
    // Brute-force guard: 5 attempts per 15 minutes per IP.
    ipRateLimit({
      limit: 5,
      windowMs: 15 * 60_000,
      trustProxy: security.trustProxy,
      name: 'login',
      now: security.now,
    }),
    async (c) => {
      if (auth.mode !== 'password') return c.json({ error: 'password_login_disabled' }, 404);
      const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      const password = typeof form.password === 'string' ? form.password : '';
      const next = safeNext(typeof form.next === 'string' ? form.next : undefined);
      if (
        !password ||
        password.length > 1024 ||
        !(await verifyPassword(password, auth.passwordHash))
      ) {
        return c.redirect(`/login?e=1&next=${encodeURIComponent(next)}`, 303);
      }
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
