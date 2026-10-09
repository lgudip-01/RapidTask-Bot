import type { ParsedMessage } from '@planner/shared';
import { addWallDays, addWallMinutes, wallCompare, wallToInstant } from './local-time';

/** A parsed capture converted to instants, ready to create. */
export type ResolvedCapture =
  | {
      kind: 'event';
      title: string;
      start: Date;
      end: Date;
      allDay: boolean;
      /** Present for all-day events: local dates, end exclusive. */
      startDate: string | null;
      endDate: string | null;
      notes: string | null;
    }
  | {
      kind: 'task';
      title: string;
      due: Date | null;
      dueAllDay: boolean;
      /** Local due date ("YYYY-MM-DD"), for Google Tasks (date-only). */
      dueDate: string | null;
      notes: string | null;
    };

const DEFAULT_EVENT_MINUTES = 60;
const DAY_MS = 86_400_000;
/** Captures must land between yesterday and two years out. */
const MIN_PAST_MS = DAY_MS;
const MAX_FUTURE_MS = 730 * DAY_MS;

export class OutOfRangeError extends Error {}

function checkRange(d: Date, now: Date) {
  const t = d.getTime();
  if (t < now.getTime() - MIN_PAST_MS || t > now.getTime() + MAX_FUTURE_MS) {
    throw new OutOfRangeError('date out of range');
  }
}

/** Converts wall-clock fields to instants and repairs common end-time slips. */
export function resolveParsed(p: ParsedMessage, timeZone: string, now: Date): ResolvedCapture {
  if (p.kind === 'event') {
    const start = p.start!;
    let end = p.end!;
    if (p.allDay) {
      // End is exclusive; a same-day or inverted end means a single day.
      if (wallCompare(end, start) <= 0) end = addWallDays(start, 1);
    } else if (wallCompare(end, start) <= 0) {
      // "11pm-1am" crosses midnight; anything else gets the default duration.
      const nextDay = addWallDays(end, 1);
      end =
        wallCompare(nextDay, start) > 0 && wallCompare(nextDay, addWallDays(start, 1)) < 0
          ? nextDay
          : addWallMinutes(start, DEFAULT_EVENT_MINUTES);
    }
    const startAt = wallToInstant(start, timeZone);
    checkRange(startAt, now);
    return {
      kind: 'event',
      title: p.title!,
      start: startAt,
      end: wallToInstant(end, timeZone),
      allDay: p.allDay,
      startDate: p.allDay ? start : null,
      endDate: p.allDay ? end : null,
      notes: p.notes,
    };
  }
  if (p.kind === 'task') {
    const due = p.due ? wallToInstant(p.due, timeZone) : null;
    if (due) checkRange(due, now);
    return {
      kind: 'task',
      title: p.title!,
      due,
      dueAllDay: p.due ? p.allDay : true,
      dueDate: p.due ? p.due.slice(0, 10) : null,
      notes: p.notes,
    };
  }
  throw new Error(`cannot resolve ${p.kind}`);
}
