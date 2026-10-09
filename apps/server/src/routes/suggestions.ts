import {
  AcceptSuggestionSchema,
  dateInZone,
  startOfDateInZone,
  SUGGESTION_STATUSES,
  type Suggestion,
} from '@planner/shared';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { suggestions } from '../db/schema';
import { badRequest, readJson } from '../http';
import type { ResolvedCapture } from '../parser/resolve';

const ListQuery = z.object({ status: z.enum(SUGGESTION_STATUSES).optional() });
const toJson = (r: typeof suggestions.$inferSelect): Suggestion => ({
  ...r,
  proposedDue: r.proposedDue?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

/** Suggestions inbox: items the bot couldn't finish. Accepting creates the (edited) item. */
export function suggestionRoutes({ db, capture, timeZone }: AppDeps) {
  const find = (id: string) => db.select().from(suggestions).where(eq(suggestions.id, id)).get();

  return new Hono()
    .get('/', (c) => {
      const q = ListQuery.safeParse(c.req.query());
      if (!q.success) return badRequest(c, q.error);
      const rows = db
        .select()
        .from(suggestions)
        .where(eq(suggestions.status, q.data.status ?? 'pending'))
        .orderBy(desc(suggestions.createdAt))
        .all();
      return c.json<{ suggestions: Suggestion[] }>({ suggestions: rows.map(toJson) });
    })
    .post('/:id/accept', async (c) => {
      const s = find(c.req.param('id'));
      if (!s) return c.json({ error: 'not_found' }, 404);
      if (s.status !== 'pending') return c.json({ error: 'already_resolved' }, 409);
      if (!capture) return c.json({ error: 'capture_not_configured' }, 503);
      const body = AcceptSuggestionSchema.safeParse(await readJson(c));
      if (!body.success) return badRequest(c, body.error);
      const b = body.data;

      let item: ResolvedCapture;
      if (b.kind === 'task') {
        const due = b.due ? new Date(b.due) : null;
        item = {
          kind: 'task',
          title: b.title,
          due,
          dueAllDay: b.dueAllDay,
          dueDate: due ? dateInZone(due, timeZone) : null,
          notes: null,
        };
      } else if (b.when.allDay) {
        item = {
          kind: 'event',
          title: b.title,
          start: startOfDateInZone(b.when.startDate, timeZone),
          end: startOfDateInZone(b.when.endDate, timeZone),
          allDay: true,
          startDate: b.when.startDate,
          endDate: b.when.endDate,
          notes: null,
        };
      } else {
        item = {
          kind: 'event',
          title: b.title,
          start: new Date(b.when.start),
          end: new Date(b.when.end),
          allDay: false,
          startDate: null,
          endDate: null,
          notes: null,
        };
      }
      const created = await capture.creator.create(item);
      db.update(suggestions).set({ status: 'accepted' }).where(eq(suggestions.id, s.id)).run();
      return c.json({ created }, 201);
    })
    .post('/:id/dismiss', (c) => {
      const s = find(c.req.param('id'));
      if (!s) return c.json({ error: 'not_found' }, 404);
      db.update(suggestions).set({ status: 'dismissed' }).where(eq(suggestions.id, s.id)).run();
      return c.body(null, 204);
    });
}
