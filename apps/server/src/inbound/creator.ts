import { eq, max } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client';
import { calendarEvents, tasks, type CaptureRow, type TaskRow } from '../db/schema';
import type { ResolvedCapture } from '../parser/resolve';

export interface CreatedItem {
  kind: 'task' | 'event';
  source: 'local';
  itemId: string;
  externalId: string;
  title: string;
}

export interface ItemCreatorOptions {
  db: Db;
  now: () => Date;
}

/**
 * Stores captured items (texts, quick add, accepted suggestions) in the app's own database —
 * the single home for everything the owner creates. Nothing is written to Google.
 */
export class ItemCreator {
  constructor(private readonly o: ItemCreatorOptions) {}

  async create(item: ResolvedCapture): Promise<CreatedItem> {
    const { db, now } = this.o;
    const at = now();
    const id = randomUUID();

    if (item.kind === 'event') {
      await db
        .insert(calendarEvents)
        .values({
          id,
          source: 'local',
          externalId: id,
          title: item.title,
          start: item.start,
          end: item.end,
          allDay: item.allDay,
          description: item.notes,
          updatedAt: at,
          syncedAt: at,
        })
        .run();
    } else {
      const top =
        (
          await db
            .select({ v: max(tasks.sortOrder) })
            .from(tasks)
            .get()
        )?.v ?? 0;
      await db
        .insert(tasks)
        .values({
          id,
          source: 'local',
          externalId: id,
          title: item.title,
          notes: item.notes,
          due: item.due,
          dueAllDay: item.dueAllDay,
          status: 'todo',
          sortOrder: top + 1,
          createdAt: at,
          updatedAt: at,
          syncedAt: at,
        })
        .run();
    }
    return { kind: item.kind, source: 'local', itemId: id, externalId: id, title: item.title };
  }

  /** UNDO: deletes a captured item. */
  async remove(c: CaptureRow): Promise<void> {
    const table = c.kind === 'event' ? calendarEvents : tasks;
    await this.o.db.delete(table).where(eq(table.id, c.itemId)).run();
  }

  /** DONE <n>: marks a task done; for Canvas assignments this is a Planner-only override. */
  async complete(t: TaskRow): Promise<void> {
    const at = this.o.now();
    await this.o.db
      .update(tasks)
      .set({
        status: 'done',
        completedAt: at,
        updatedAt: at,
        statusSetLocally: t.source !== 'local',
      })
      .where(eq(tasks.id, t.id))
      .run();
  }
}
