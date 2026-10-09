import { addDays, parseWallDateTime, startOfDateInZone } from '@planner/shared';
import type { SyncItem } from '../sync/types';
import type { GEvent, GEventTime } from './calendar-client';

const DESCRIPTION_MAX = 8000;
/** Event types that are not real calendar entries for a planner. */
const SKIPPED_TYPES = new Set(['workingLocation']);

/** `${calendarId}/${eventId}`: event ids are only unique within a calendar. */
export const eventExternalId = (calendarId: string, eventId: string) => `${calendarId}/${eventId}`;

export function splitEventExternalId(externalId: string) {
  const i = externalId.indexOf('/');
  if (i < 0) throw new Error('not a google calendar external id');
  return { calendarId: externalId.slice(0, i), eventId: externalId.slice(i + 1) };
}

export interface NormalizeContext {
  calendarId: string;
  calendarName: string | null;
  /** Calendar's own zone, used for date-times that lack an offset. */
  calendarTimeZone: string;
  /** APP_TIMEZONE, used to anchor all-day dates. */
  appTimeZone: string;
}

function toInstant(t: GEventTime, ctx: NormalizeContext): Date {
  if (t.date) return startOfDateInZone(t.date, ctx.appTimeZone);
  if (t.dateTime) return parseWallDateTime(t.dateTime, t.timeZone ?? ctx.calendarTimeZone);
  throw new Error('event time has neither date nor dateTime');
}

/**
 * Google event → upsert or delete. Recurring events arrive as single instances
 * (`singleEvents=true`), each with its own id. Returns null for events we ignore.
 */
export function normalizeGoogleEvent(e: GEvent, ctx: NormalizeContext): SyncItem | null {
  const externalId = eventExternalId(ctx.calendarId, e.id);
  if (e.status === 'cancelled') {
    return { kind: 'delete', entity: 'event', source: 'google_calendar', externalId };
  }
  if (e.eventType && SKIPPED_TYPES.has(e.eventType)) return null;
  if (!e.start) return null;

  const allDay = Boolean(e.start.date);
  const start = toInstant(e.start, ctx);
  let end: Date;
  if (e.end) end = toInstant(e.end, ctx);
  else if (allDay) end = startOfDateInZone(addDays(e.start.date!, 1), ctx.appTimeZone);
  else end = start;

  return {
    kind: 'event',
    data: {
      source: 'google_calendar',
      externalId,
      title: e.summary?.trim() || '(no title)',
      start,
      end,
      allDay,
      location: e.location ?? null,
      description: e.description ? e.description.slice(0, DESCRIPTION_MAX) : null,
      calendarName: ctx.calendarName,
      url: e.htmlLink ?? null,
      updatedAt: e.updated ? new Date(e.updated) : start,
    },
  };
}
