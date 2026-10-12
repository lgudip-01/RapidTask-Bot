import {
  EventPatchSchema,
  NewEventSchema,
  startOfDateInZone,
  type CalendarEvent,
  type EventTimes,
} from '@planner/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { AppDeps } from '../app';
import { toEventJson } from '../db/mappers';
import { calendarEvents } from '../db/schema';
import { badRequest, readJson } from '../http';

function toInstants(when: EventTimes, timeZone: string) {
  return when.allDay
    ? {
        start: startOfDateInZone(when.startDate, timeZone),
        end: startOfDateInZone(when.endDate, timeZone),
        allDay: true,
      }
    : { start: new Date(when.start), end: new Date(when.end), allDay: false };
}

const readOnly = (source: string) => ({
  error: 'read_only_source',
  message: `${source} events are read-only; only Planner events can be changed.`,
});

/** Planner-only events. Google Calendar and Canvas events are read-only mirrors. */
export function eventRoutes({ db, now, timeZone }: AppDeps) {
  const find = (id: string) =>
    db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get();

  return new Hono()
    .get('/:id', async (c) => {
      const row = await find(c.req.param('id'));
      return row
        ? c.json<{ event: CalendarEvent }>({ event: toEventJson(row) })
        : c.json({ error: 'not_found' }, 404);
    })
    .post('/', async (c) => {
      const body = NewEventSchema.safeParse(await readJson(c));
      if (!body.success) return badRequest(c, body.error);
      const id = randomUUID();
      const at = now();
      const row = await db
        .insert(calendarEvents)
        .values({
          id,
          source: 'local',
          externalId: id,
          title: body.data.title,
          location: body.data.location ?? null,
          description: body.data.description ?? null,
          ...toInstants(body.data.when, timeZone),
          updatedAt: at,
          syncedAt: at,
        })
        .returning()
        .get();
      return c.json<{ event: CalendarEvent }>({ event: toEventJson(row) }, 201);
    })
    .patch('/:id', async (c) => {
      const existing = await find(c.req.param('id'));
      if (!existing) return c.json({ error: 'not_found' }, 404);
      if (existing.source !== 'local') return c.json(readOnly(existing.source), 403);
      const body = EventPatchSchema.safeParse(await readJson(c));
      if (!body.success) return badRequest(c, body.error);
      const p = body.data;
      const row = await db
        .update(calendarEvents)
        .set({
          ...(p.title !== undefined && { title: p.title }),
          ...(p.location !== undefined && { location: p.location }),
          ...(p.description !== undefined && { description: p.description }),
          ...(p.when && toInstants(p.when, timeZone)),
          updatedAt: now(),
        })
        .where(eq(calendarEvents.id, existing.id))
        .returning()
        .get();
      return c.json<{ event: CalendarEvent }>({ event: toEventJson(row!) });
    })
    .delete('/:id', async (c) => {
      const existing = await find(c.req.param('id'));
      if (!existing) return c.json({ error: 'not_found' }, 404);
      if (existing.source !== 'local') return c.json(readOnly(existing.source), 403);
      await db.delete(calendarEvents).where(eq(calendarEvents.id, existing.id)).run();
      return c.body(null, 204);
    });
}
