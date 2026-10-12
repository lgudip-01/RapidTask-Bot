import { CalendarEventSchema, TaskSchema } from '@planner/shared';
import { z } from 'zod';
import type { Db } from '../db/client';
import { calendarEvents, tasks } from '../db/schema';

/** The JSON export written by `exportData` (nightly Telegram backups, `npm run backup -- --stdout`). */
export const ExportSchema = z.object({
  version: z.literal(2),
  exportedAt: z.string(),
  tasks: z.array(TaskSchema),
  localEvents: z.array(CalendarEventSchema),
});

const date = (s: string) => new Date(s);
const dateOrNull = (s: string | null) => (s ? new Date(s) : null);

/**
 * Restores a JSON export into the database (e.g. a fresh Turso database). Rows are matched by id:
 * existing rows win and are left untouched, so running it twice is harmless. Synced Canvas/Google
 * rows come back on the next sync anyway; the export matters for Planner-only items.
 */
export async function importData(db: Db, raw: unknown) {
  const data = ExportSchema.parse(raw);
  let taskCount = 0;
  let eventCount = 0;
  await db.transaction(async (tx) => {
    for (const t of data.tasks) {
      const res = await tx
        .insert(tasks)
        .values({
          ...t,
          due: dateOrNull(t.due),
          createdAt: date(t.createdAt),
          completedAt: dateOrNull(t.completedAt),
          updatedAt: date(t.updatedAt),
          syncedAt: date(t.syncedAt),
        })
        .onConflictDoNothing()
        .run();
      taskCount += res.rowsAffected;
    }
    for (const e of data.localEvents) {
      const res = await tx
        .insert(calendarEvents)
        .values({
          ...e,
          start: date(e.start),
          end: date(e.end),
          updatedAt: date(e.updatedAt),
          syncedAt: date(e.syncedAt),
        })
        .onConflictDoNothing()
        .run();
      eventCount += res.rowsAffected;
    }
  });
  return { tasks: taskCount, events: eventCount, skipped: data.tasks.length - taskCount };
}
