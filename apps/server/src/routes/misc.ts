import {
  SettingsPatchSchema,
  type AgendaItem,
  type IntegrationStatus,
  type Settings,
} from '@planner/shared';
import { and, asc, gt, lt, sql, type AnyColumn } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { toEventJson, toTaskJson } from '../db/mappers';
import { calendarEvents, tasks } from '../db/schema';
import { badRequest, readJson } from '../http';

const SearchQuery = z.object({ q: z.string().trim().min(1).max(100) });
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
/** Substring match with %, _ and \ in the query treated literally. */
const contains = (col: AnyColumn, pattern: string) => sql`${col} LIKE ${pattern} ESCAPE '\\'`;
const YEAR = 365 * 86_400_000;

/** Settings, search, and integration status for the web UI. */
export function miscRoutes(deps: AppDeps) {
  const { db, now, settings } = deps;
  return new Hono()
    .get('/settings', async (c) =>
      c.json<{ settings: Settings }>({ settings: await settings.get() }),
    )
    .patch('/settings', async (c) => {
      const body = SettingsPatchSchema.safeParse(await readJson(c));
      if (!body.success) return badRequest(c, body.error);
      return c.json<{ settings: Settings }>({ settings: await settings.patch(body.data) });
    })

    .get('/search', async (c) => {
      const q = SearchQuery.safeParse(c.req.query());
      if (!q.success) return badRequest(c, q.error);
      const pattern = `%${escapeLike(q.data.q)}%`;
      const t = now().getTime();
      const taskRows = await db
        .select()
        .from(tasks)
        .where(contains(tasks.title, pattern))
        .orderBy(asc(tasks.status), asc(tasks.due))
        .limit(25)
        .all();
      const eventRows = await db
        .select()
        .from(calendarEvents)
        .where(
          and(
            contains(calendarEvents.title, pattern),
            gt(calendarEvents.end, new Date(t - YEAR)),
            lt(calendarEvents.start, new Date(t + YEAR)),
          ),
        )
        .orderBy(asc(calendarEvents.start))
        .limit(25)
        .all();
      const items: AgendaItem[] = [
        ...eventRows.map((e) => ({
          kind: 'event' as const,
          at: e.start.toISOString(),
          item: toEventJson(e),
        })),
        ...taskRows.map((r) => ({
          kind: 'task' as const,
          at: (r.due ?? r.createdAt).toISOString(),
          overdue: false,
          item: toTaskJson(r),
        })),
      ];
      return c.json({ items });
    })

    .get('/me', (c) =>
      c.json({
        authMode: deps.security?.auth.mode ?? 'none',
        writeEventsToGoogle: deps.writeEventsToGoogle ?? false,
      }),
    )
    .get('/status', async (c) =>
      c.json<{ integrations: IntegrationStatus[] }>({
        integrations: deps.integrations ? await deps.integrations() : [],
      }),
    )
    .post('/sources/google/disconnect', async (c) => {
      if (!deps.disconnectGoogle) return c.json({ error: 'google_not_configured' }, 503);
      await deps.disconnectGoogle();
      return c.body(null, 204);
    });
}
