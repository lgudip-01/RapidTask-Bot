import type { Announcement, Course } from '@planner/shared';
import { IsoDateTime } from '@planner/shared';
import { asc, desc, gte } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { toAnnouncementJson, toCourseJson } from '../db/mappers';
import { announcements, courses } from '../db/schema';
import { badRequest } from '../http';

const CoursesQuery = z.object({ includeGrades: z.enum(['true', 'false']).optional() });
const AnnouncementsQuery = z.object({ since: IsoDateTime.optional() });

/** Read-only views of synced LMS data. Grades are omitted unless explicitly requested. */
export function canvasRoutes({ db, now }: AppDeps) {
  return new Hono()
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
