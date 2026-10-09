import {
  ConfirmSchema,
  EventPatchSchema,
  NewEventSchema,
  type CalendarEvent,
  type EventTimes,
} from '@planner/shared';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AppDeps } from '../app';
import { toEventJson } from '../db/mappers';
import { calendarEvents } from '../db/schema';
import {
  GoogleApiError,
  type GEventWrite,
  type GoogleCalendarClient,
} from '../google/calendar-client';
import {
  eventExternalId,
  normalizeGoogleEvent,
  splitEventExternalId,
} from '../google/calendar-normalize';
import { badRequest, readJson } from '../http';
import { upsertItems } from '../sync/upsert';

export interface CalendarWriter {
  client: GoogleCalendarClient;
  defaultCalendarId: string;
  appTimeZone: string;
}

function toGoogleTimes(when: EventTimes, tz: string): Pick<GEventWrite, 'start' | 'end'> {
  return when.allDay
    ? { start: { date: when.startDate }, end: { date: when.endDate } }
    : {
        start: { dateTime: when.start, timeZone: tz },
        end: { dateTime: when.end, timeZone: tz },
      };
}

function confirmationRequired(c: Context, preview: Record<string, unknown>) {
  return c.json(
    {
      error: 'confirmation_required',
      message: 'This changes your Google Calendar. Resend with "confirm": true.',
      preview,
    },
    400,
  );
}

/** Create/update/delete Google Calendar events. Every write requires `confirm: true`. */
export function calendarRoutes({ db, now, calendar }: AppDeps) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    if (!calendar) return c.json({ error: 'google_not_configured' }, 503);
    await next();
  });
  const cal = () => calendar!;

  const findGoogleEvent = (id: string) =>
    db
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.source, 'google_calendar')))
      .get();

  const store = (calendarId: string, raw: Parameters<typeof normalizeGoogleEvent>[0]) => {
    const item = normalizeGoogleEvent(raw, {
      calendarId,
      calendarName: null,
      calendarTimeZone: cal().appTimeZone,
      appTimeZone: cal().appTimeZone,
    });
    if (item) upsertItems(db, [item], now());
    const row = db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.source, 'google_calendar'),
          eq(calendarEvents.externalId, eventExternalId(calendarId, raw.id)),
        ),
      )
      .get();
    return row ? toEventJson(row) : null;
  };

  app.post('/events', async (c) => {
    const body = NewEventSchema.safeParse(await readJson(c));
    if (!body.success) return badRequest(c, body.error);
    const { confirm, calendarId = cal().defaultCalendarId, when, ...rest } = body.data;
    if (confirm !== true) {
      return confirmationRequired(c, { action: 'create', calendarId, title: rest.title, when });
    }
    const created = await cal().client.insertEvent(calendarId, {
      summary: rest.title,
      location: rest.location ?? null,
      description: rest.description ?? null,
      ...toGoogleTimes(when, cal().appTimeZone),
    });
    return c.json<{ event: CalendarEvent | null }>({ event: store(calendarId, created) }, 201);
  });

  app.patch('/events/:id', async (c) => {
    const existing = findGoogleEvent(c.req.param('id'));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const body = EventPatchSchema.safeParse(await readJson(c));
    if (!body.success) return badRequest(c, body.error);
    const { confirm, when, ...rest } = body.data;
    const { calendarId, eventId } = splitEventExternalId(existing.externalId);
    if (confirm !== true) {
      return confirmationRequired(c, {
        action: 'update',
        calendarId,
        current: existing.title,
        changes: { ...rest, ...(when && { when }) },
      });
    }
    const updated = await cal().client.patchEvent(calendarId, eventId, {
      ...(rest.title !== undefined && { summary: rest.title }),
      ...(rest.location !== undefined && { location: rest.location }),
      ...(rest.description !== undefined && { description: rest.description }),
      ...(when && toGoogleTimes(when, cal().appTimeZone)),
    });
    return c.json<{ event: CalendarEvent | null }>({ event: store(calendarId, updated) });
  });

  app.delete('/events/:id', async (c) => {
    const existing = findGoogleEvent(c.req.param('id'));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const body = ConfirmSchema.safeParse((await readJson(c)) ?? {});
    if (!body.success) return badRequest(c, body.error);
    const { calendarId, eventId } = splitEventExternalId(existing.externalId);
    if (body.data.confirm !== true) {
      return confirmationRequired(c, { action: 'delete', calendarId, title: existing.title });
    }
    try {
      await cal().client.deleteEvent(calendarId, eventId);
    } catch (e) {
      // Already gone upstream: still remove our copy.
      if (!(e instanceof GoogleApiError && (e.status === 404 || e.status === 410))) throw e;
    }
    db.delete(calendarEvents).where(eq(calendarEvents.id, existing.id)).run();
    return c.body(null, 204);
  });

  return app;
}
