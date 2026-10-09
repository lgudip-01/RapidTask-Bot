import type { Source } from '@planner/shared';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client';
import { calendarEvents, syncState, tasks } from '../db/schema';
import type { EventInput, SyncBatch, SyncSource, TaskInput } from './types';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface ApplyResult {
  upserted: number;
  deleted: number;
}

function assertSyncable(source: Source) {
  if (source === 'local') throw new Error('sync sources may not write local items');
}

function upsertEvent(tx: Tx, e: EventInput, now: Date) {
  const fields = {
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    location: e.location ?? null,
    description: e.description ?? null,
    calendarName: e.calendarName ?? null,
    url: e.url ?? null,
    updatedAt: e.updatedAt,
    syncedAt: now,
  };
  tx.insert(calendarEvents)
    .values({ id: randomUUID(), source: e.source, externalId: e.externalId, ...fields })
    .onConflictDoUpdate({ target: [calendarEvents.source, calendarEvents.externalId], set: fields })
    .run();
}

function upsertTask(tx: Tx, t: TaskInput, now: Date) {
  const fields = {
    title: t.title,
    notes: t.notes ?? null,
    due: t.due ?? null,
    dueAllDay: t.dueAllDay,
    priority: t.priority ?? null,
    courseOrProject: t.courseOrProject ?? null,
    url: t.url ?? null,
    updatedAt: t.updatedAt,
    syncedAt: now,
  };
  const completedAt = t.completedAt ?? null;
  tx.insert(tasks)
    .values({
      id: randomUUID(),
      source: t.source,
      externalId: t.externalId,
      status: t.status,
      completedAt,
      createdAt: t.createdAt ?? now,
      ...fields,
    })
    .onConflictDoUpdate({
      target: [tasks.source, tasks.externalId],
      set: {
        ...fields,
        // A status changed in this app wins over the provider's (Canvas is read-only).
        status: sql`CASE WHEN ${tasks.statusSetLocally} THEN ${tasks.status} ELSE ${t.status} END`,
        completedAt: sql`CASE WHEN ${tasks.statusSetLocally} THEN ${tasks.completedAt} ELSE ${completedAt?.getTime() ?? null} END`,
      },
    })
    .run();
}

/**
 * Stores one batch atomically: items, deletes, and the advanced cursor commit together,
 * so a failure anywhere leaves the previous cursor in place and nothing half-written.
 */
export function applySyncBatch(db: Db, src: SyncSource, batch: SyncBatch, now: Date): ApplyResult {
  return db.transaction((tx) => {
    let upserted = 0;
    let deleted = 0;
    const seenEvents = new Map<Source, string[]>();
    const seenTasks = new Map<Source, string[]>();
    const remember = (m: Map<Source, string[]>, s: Source, id: string) =>
      m.set(s, [...(m.get(s) ?? []), id]);

    for (const item of batch.items) {
      if (item.kind === 'event') {
        assertSyncable(item.data.source);
        upsertEvent(tx, item.data, now);
        remember(seenEvents, item.data.source, item.data.externalId);
        upserted++;
      } else if (item.kind === 'task') {
        assertSyncable(item.data.source);
        upsertTask(tx, item.data, now);
        remember(seenTasks, item.data.source, item.data.externalId);
        upserted++;
      } else {
        assertSyncable(item.source);
        const table = item.entity === 'event' ? calendarEvents : tasks;
        deleted += tx
          .delete(table)
          .where(and(eq(table.source, item.source), eq(table.externalId, item.externalId)))
          .run().changes;
      }
    }

    if (batch.fullResync) {
      for (const [table, owned, seen] of [
        [calendarEvents, src.owns.events, seenEvents],
        [tasks, src.owns.tasks, seenTasks],
      ] as const) {
        for (const source of owned) {
          assertSyncable(source);
          const keep = seen.get(source) ?? [];
          deleted += tx
            .delete(table)
            .where(
              keep.length
                ? and(eq(table.source, source), notInArray(table.externalId, keep))
                : eq(table.source, source),
            )
            .run().changes;
        }
      }
    }

    tx.insert(syncState)
      .values({
        source: src.name,
        cursor: batch.nextCursor,
        lastSyncAt: now,
        lastError: null,
        consecutiveFailures: 0,
      })
      .onConflictDoUpdate({
        target: syncState.source,
        set: { cursor: batch.nextCursor, lastSyncAt: now, lastError: null, consecutiveFailures: 0 },
      })
      .run();

    return { upserted, deleted };
  });
}

/** Rows of `source` currently stored, keyed by externalId → id (for tests and diagnostics). */
export function idsBySource(db: Db, sources: Source[]) {
  return {
    events: db
      .select({ id: calendarEvents.id, externalId: calendarEvents.externalId })
      .from(calendarEvents)
      .where(inArray(calendarEvents.source, sources))
      .all(),
    tasks: db
      .select({ id: tasks.id, externalId: tasks.externalId })
      .from(tasks)
      .where(inArray(tasks.source, sources))
      .all(),
  };
}
