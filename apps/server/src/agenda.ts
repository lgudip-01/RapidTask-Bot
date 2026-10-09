import type { AgendaItem } from '@planner/shared';
import { and, gt, gte, isNotNull, lt, ne } from 'drizzle-orm';
import type { Db } from './db/client';
import { toEventJson, toTaskJson } from './db/mappers';
import { calendarEvents, tasks, type TaskRow } from './db/schema';

const DAY_MS = 86_400_000;

/** A task is overdue once its deadline passes; date-only tasks stay current through their day. */
function isOverdue(t: TaskRow, now: Date) {
  if (!t.due || t.status === 'done') return false;
  // Date-only: approximate end of day as +24h (off by an hour on DST change days; acceptable).
  const deadline = t.dueAllDay ? t.due.getTime() + DAY_MS : t.due.getTime();
  return deadline <= now.getTime();
}

/**
 * Events overlapping [from, to) plus tasks due in [from, to), merged and sorted.
 * With `includeOverdue`, also open tasks due before `from`.
 */
export function queryAgenda(
  db: Db,
  from: Date,
  to: Date,
  opts: { includeOverdue: boolean; now: Date },
): AgendaItem[] {
  const events = db
    .select()
    .from(calendarEvents)
    .where(and(lt(calendarEvents.start, to), gt(calendarEvents.end, from)))
    .all();
  const dueInRange = db
    .select()
    .from(tasks)
    .where(and(isNotNull(tasks.due), gte(tasks.due, from), lt(tasks.due, to)))
    .all();
  const overdue = opts.includeOverdue
    ? db
        .select()
        .from(tasks)
        .where(and(isNotNull(tasks.due), lt(tasks.due, from), ne(tasks.status, 'done')))
        .all()
    : [];

  const rows: { item: AgendaItem; ms: number; allDay: boolean }[] = [
    ...events.map((e) => ({
      item: { kind: 'event' as const, at: e.start.toISOString(), item: toEventJson(e) },
      ms: e.start.getTime(),
      allDay: e.allDay,
    })),
    ...[...overdue, ...dueInRange].map((t) => ({
      item: {
        kind: 'task' as const,
        at: t.due!.toISOString(),
        overdue: isOverdue(t, opts.now),
        item: toTaskJson(t),
      },
      ms: t.due!.getTime(),
      allDay: t.dueAllDay,
    })),
  ];

  // Chronological; at equal times all-day first, then events before tasks, then by title.
  rows.sort(
    (a, b) =>
      a.ms - b.ms ||
      Number(b.allDay) - Number(a.allDay) ||
      (a.item.kind === b.item.kind ? 0 : a.item.kind === 'event' ? -1 : 1) ||
      a.item.item.title.localeCompare(b.item.item.title),
  );
  return rows.map((r) => r.item);
}
