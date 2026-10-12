import { addDays, dateInZone, startOfDateInZone } from '@planner/shared';
import { queryAgenda } from '../agenda';
import type { Db } from '../db/client';
import { formatDate, formatTime } from './format';

export interface TodayList {
  text: string;
  /** Task ids in the order they were numbered (DONE <n> refers to these). */
  taskIds: string[];
}

/** Today's agenda as a short text: events as bullets, open tasks numbered (overdue last). */
export async function buildTodayList(db: Db, now: Date, timeZone: string): Promise<TodayList> {
  const today = dateInZone(now, timeZone);
  const from = startOfDateInZone(today, timeZone);
  const to = startOfDateInZone(addDays(today, 1), timeZone);
  const items = await queryAgenda(db, from, to, { includeOverdue: true, now });

  const events: string[] = [];
  const dueToday: { id: string; line: string }[] = [];
  const overdue: { id: string; line: string }[] = [];
  for (const it of items) {
    if (it.kind === 'event') {
      const e = it.item;
      events.push(
        e.allDay
          ? `• all day: ${e.title}`
          : `• ${formatTime(new Date(e.start), timeZone)} ${e.title}`,
      );
      continue;
    }
    const t = it.item;
    if (t.status === 'done') continue;
    const due = new Date(t.due!);
    if (due.getTime() < from.getTime()) {
      overdue.push({ id: t.id, line: `${t.title} (was due ${formatDate(due, timeZone)})` });
    } else {
      dueToday.push({
        id: t.id,
        line: t.dueAllDay ? t.title : `${t.title} — due ${formatTime(due, timeZone)}`,
      });
    }
  }

  const numbered = [...dueToday, ...overdue];
  const lines = [`Today, ${formatDate(now, timeZone)}`];
  if (!events.length && !numbered.length) lines.push('Nothing scheduled.');
  lines.push(...events);
  dueToday.forEach((t, i) => lines.push(`${i + 1}. ${t.line}`));
  if (overdue.length) {
    lines.push('Overdue:');
    overdue.forEach((t, i) => lines.push(`${dueToday.length + i + 1}. ${t.line}`));
  }
  if (numbered.length) lines.push('Reply DONE <n> to check one off.');
  return { text: lines.join('\n'), taskIds: numbered.map((t) => t.id) };
}
