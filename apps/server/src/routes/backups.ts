import { Hono } from 'hono';
import type { AppDeps } from '../app';

/** Backup status for Settings, and a manual "Back up now". */
export function backupRoutes({ backups }: AppDeps) {
  return new Hono()
    .get('/', async (c) => {
      if (!backups) return c.json({ error: 'backups_not_configured' }, 503);
      return c.json({
        status: await backups.status(),
        recent: (await backups.recent(10)).map((r) => ({
          ...r,
          startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt?.toISOString() ?? null,
        })),
      });
    })
    .post('/run', async (c) => {
      if (!backups) return c.json({ error: 'backups_not_configured' }, 503);
      if (backups.isRunning()) return c.json({ error: 'already_running' }, 409);
      const run = await backups.runNow('manual');
      return c.json({ ok: run.ok, error: run.error, file: run.file }, run.ok ? 200 : 500);
    });
}
