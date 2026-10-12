import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { AppDeps } from '../app';

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Serverless heartbeat: due syncs, reminders/digest/health alerts, and the nightly backup.
 * Vercel Cron and outside pingers (e.g. cron-job.org every 5 minutes) call it with
 * `Authorization: Bearer <CRON_SECRET>`. Public route; the secret is the authentication.
 * The response carries counts only, never content.
 */
export function cronRoutes({ cron }: AppDeps) {
  const handler = new Hono();
  const tick = handler.all('/tick', async (c) => {
    if (!cron) return c.body(null, 404);
    const auth = c.req.header('authorization') ?? '';
    if (!safeEqual(auth, `Bearer ${cron.secret}`)) return c.json({ error: 'unauthorized' }, 401);
    return c.json(await cron.tick());
  });
  return tick;
}
