import {
  CanvasConnectSchema,
  IsoDateTime,
  type Announcement,
  type CanvasConnection,
  type Course,
} from '@planner/shared';
import { CanvasApiError } from '@planner/canvas';
import { CanvasFeedError } from '../canvas/connection';
import { asc, desc, gte } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { toAnnouncementJson, toCourseJson } from '../db/mappers';
import { announcements, courses } from '../db/schema';
import { badRequest, readJson } from '../http';
import { log, sanitizeError } from '../log';

const CoursesQuery = z.object({ includeGrades: z.enum(['true', 'false']).optional() });
const AnnouncementsQuery = z.object({ since: IsoDateTime.optional() });

/** What the owner sees when a connection attempt fails (never the token or Canvas's body). */
function connectError(e: unknown): { status: 400 | 502; message: string } {
  if (e instanceof CanvasFeedError) {
    return {
      status: 400,
      message: e.status
        ? 'Canvas did not accept that calendar feed link. Copy it again from Calendar → Calendar Feed.'
        : 'That link is not a calendar feed. In Canvas, open Calendar → Calendar Feed and copy the link.',
    };
  }
  if (e instanceof CanvasApiError) {
    if (e.status === 401)
      return {
        status: 400,
        message: 'Canvas rejected that token. Create a new one and try again.',
      };
    if (e.status === 404)
      return { status: 400, message: 'That address answered, but it does not look like Canvas.' };
    return {
      status: 502,
      message: `Canvas answered with an error (${e.status}). Try again later.`,
    };
  }
  if (e instanceof Error && /https|Canvas address|access token/.test(e.message))
    return { status: 400, message: e.message };
  return { status: 400, message: 'Could not reach that address. Check the Canvas URL.' };
}

/**
 * Canvas: connect from Settings, plus read-only views of synced LMS data. Grades are omitted
 * unless explicitly requested.
 */
export function canvasRoutes({ db, now, canvas, background }: AppDeps) {
  return new Hono()
    .get('/canvas/connection', async (c) => {
      if (!canvas) return c.json({ error: 'canvas_not_available' }, 503);
      return c.json<CanvasConnection>(await canvas.connection());
    })
    .post('/canvas/connect', async (c) => {
      if (!canvas?.connect) return c.json({ error: 'canvas_connect_unavailable' }, 503);
      const body = CanvasConnectSchema.safeParse(await readJson(c));
      if (!body.success) {
        // Shown as-is in the Connect Canvas form.
        const message = body.error.issues[0]?.message ?? 'Check the Canvas details';
        return c.json({ error: 'invalid_request', message }, 400);
      }
      try {
        const { name, kind, firstSync } = await canvas.connect(body.data);
        if (background) background(firstSync);
        return c.json({ connected: true, name, kind });
      } catch (e) {
        const err = connectError(e);
        log.warn('canvas connect failed', { error: sanitizeError(e) });
        return c.json({ error: 'canvas_connect_failed', message: err.message }, err.status);
      }
    })
    .post('/canvas/disconnect', async (c) => {
      if (!canvas?.disconnect) return c.json({ error: 'canvas_connect_unavailable' }, 503);
      await canvas.disconnect();
      return c.body(null, 204);
    })
    .get('/courses', async (c) => {
      const q = CoursesQuery.safeParse(c.req.query());
      if (!q.success) return badRequest(c, q.error);
      const rows = await db.select().from(courses).orderBy(asc(courses.name)).all();
      return c.json<{ courses: Course[] }>({
        courses: rows.map((r) => toCourseJson(r, q.data.includeGrades === 'true')),
      });
    })
    .get('/announcements', async (c) => {
      const q = AnnouncementsQuery.safeParse(c.req.query());
      if (!q.success) return badRequest(c, q.error);
      const since = q.data.since
        ? new Date(q.data.since)
        : new Date(now().getTime() - 14 * 86_400_000);
      const rows = await db
        .select()
        .from(announcements)
        .where(gte(announcements.postedAt, since))
        .orderBy(desc(announcements.postedAt))
        .all();
      return c.json<{ announcements: Announcement[] }>({
        announcements: rows.map(toAnnouncementJson),
      });
    });
}
