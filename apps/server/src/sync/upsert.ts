import type { Source } from '@planner/shared';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client';
import { announcements, calendarEvents, courses, syncState, tasks } from '../db/schema';
import type {
  AnnouncementInput,
  CourseInput,
  EventInput,
  SyncBatch,
  SyncEntity,
  SyncItem,
  SyncSource,
  TaskInput,
} from './types';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const TABLES = {
  event: calendarEvents,
  task: tasks,
  course: courses,
  announcement: announcements,
} as const;

export interface ApplyResult {
  upserted: number;
  deleted: number;
}

function assertSyncable(source: Source) {
  if (source === 'local') throw new Error('sync sources may not write local items');
}

async function upsertEvent(tx: Tx, e: EventInput, now: Date) {
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
  await tx
    .insert(calendarEvents)
    .values({ id: randomUUID(), source: e.source, externalId: e.externalId, ...fields })
    .onConflictDoUpdate({ target: [calendarEvents.source, calendarEvents.externalId], set: fields })
    .run();
}

async function upsertTask(tx: Tx, t: TaskInput, now: Date) {
  const fields = {
    title: t.title,
    notes: t.notes ?? null,
    due: t.due ?? null,
    dueAllDay: t.dueAllDay,
    priority: t.priority ?? null,
    courseOrProject: t.courseOrProject ?? null,
    url: t.url ?? null,
    pointsPossible: t.pointsPossible ?? null,
    submissionStatus: t.submissionStatus ?? null,
    updatedAt: t.updatedAt,
    syncedAt: now,
  };
  const completedAt = t.completedAt ?? null;
  await tx
    .insert(tasks)
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

async function upsertCourse(tx: Tx, c: CourseInput, now: Date) {
  const fields = {
    name: c.name,
    courseCode: c.courseCode ?? null,
    termName: c.termName ?? null,
    currentScore: c.currentScore ?? null,
    currentGrade: c.currentGrade ?? null,
    url: c.url ?? null,
    syncedAt: now,
  };
  await tx
    .insert(courses)
    .values({ id: randomUUID(), source: c.source, externalId: c.externalId, ...fields })
    .onConflictDoUpdate({ target: [courses.source, courses.externalId], set: fields })
    .run();
}

async function upsertAnnouncement(tx: Tx, a: AnnouncementInput, now: Date) {
  const fields = {
    title: a.title,
    courseName: a.courseName ?? null,
    postedAt: a.postedAt,
    url: a.url ?? null,
    syncedAt: now,
  };
  await tx
    .insert(announcements)
    .values({ id: randomUUID(), source: a.source, externalId: a.externalId, ...fields })
    .onConflictDoUpdate({ target: [announcements.source, announcements.externalId], set: fields })
    .run();
}

type Seen = Map<SyncEntity, Map<Source, string[]>>;

async function applyItems(tx: Tx, items: SyncItem[], now: Date) {
  let upserted = 0;
  let deleted = 0;
  const seen: Seen = new Map();
  const remember = (entity: SyncEntity, s: Source, id: string) => {
    const bySource = seen.get(entity) ?? new Map<Source, string[]>();
    seen.set(entity, bySource);
    const list = bySource.get(s);
    if (list) list.push(id);
    else bySource.set(s, [id]);
  };

  for (const item of items) {
    if (item.kind === 'delete') {
      assertSyncable(item.source);
      const table = TABLES[item.entity];
      deleted += (
        await tx
          .delete(table)
          .where(and(eq(table.source, item.source), eq(table.externalId, item.externalId)))
          .run()
      ).rowsAffected;
      continue;
    }
    assertSyncable(item.data.source);
    if (item.kind === 'event') await upsertEvent(tx, item.data, now);
    else if (item.kind === 'task') await upsertTask(tx, item.data, now);
    else if (item.kind === 'course') await upsertCourse(tx, item.data, now);
    else await upsertAnnouncement(tx, item.data, now);
    remember(item.kind, item.data.source, item.data.externalId);
    upserted++;
  }
  return { upserted, deleted, seen };
}

/** Applies items outside a sync run (e.g. right after a write to Google), without touching cursors. */
export function upsertItems(db: Db, items: SyncItem[], now: Date): Promise<ApplyResult> {
  return db.transaction(async (tx) => {
    const { upserted, deleted } = await applyItems(tx, items, now);
    return { upserted, deleted };
  });
}

/**
 * Stores one batch atomically: items, deletes, and the advanced cursor commit together,
 * so a failure anywhere leaves the previous cursor in place and nothing half-written.
 */
export function applySyncBatch(
  db: Db,
  src: SyncSource,
  batch: SyncBatch,
  now: Date,
): Promise<ApplyResult> {
  return db.transaction(async (tx) => {
    const applied = await applyItems(tx, batch.items, now);
    let { deleted } = applied;

    if (batch.fullResync) {
      for (const [entity, owned] of Object.entries(src.owns) as [SyncEntity, Source[]][]) {
        const table = TABLES[entity];
        for (const source of owned) {
          assertSyncable(source);
          const keep = applied.seen.get(entity)?.get(source) ?? [];
          deleted += (
            await tx
              .delete(table)
              .where(
                keep.length
                  ? and(eq(table.source, source), notInArray(table.externalId, keep))
                  : eq(table.source, source),
              )
              .run()
          ).rowsAffected;
        }
      }
    }

    await tx
      .insert(syncState)
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

    return { upserted: applied.upserted, deleted };
  });
}

/** Rows of `source` currently stored, keyed by externalId → id (for tests and diagnostics). */
export async function idsBySource(db: Db, sources: Source[]) {
  return {
    events: await db
      .select({ id: calendarEvents.id, externalId: calendarEvents.externalId })
      .from(calendarEvents)
      .where(inArray(calendarEvents.source, sources))
      .all(),
    tasks: await db
      .select({ id: tasks.id, externalId: tasks.externalId })
      .from(tasks)
      .where(inArray(tasks.source, sources))
      .all(),
  };
}
