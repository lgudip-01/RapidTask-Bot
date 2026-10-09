import { and, eq, max } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client';
import { calendarEvents, tasks, type CaptureRow, type TaskRow } from '../db/schema';
import { GoogleApiError, type GoogleCalendarClient } from '../google/calendar-client';
import {
  eventExternalId,
  normalizeGoogleEvent,
  splitEventExternalId,
} from '../google/calendar-normalize';
import {
  DEFAULT_TASK_LIST,
  googleTaskExternalId,
  splitGoogleTaskExternalId,
  type GoogleTasksClient,
} from '../google/tasks-client';
import { log, sanitizeError } from '../log';
import type { ResolvedCapture } from '../parser/resolve';
import { upsertItems } from '../sync/upsert';

export interface CreatedItem {
  kind: 'task' | 'event';
  source: 'google_calendar' | 'google_tasks' | 'local';
  itemId: string;
  externalId: string;
  title: string;
  /** Set when the Google write failed and the item was saved locally instead. */
  fallbackNote: string | null;
}

export interface ItemCreatorOptions {
  db: Db;
  now: () => Date;
  timeZone: string;
  calendar?: { client: GoogleCalendarClient; calendarId: string };
  tasks?: GoogleTasksClient;
}

const gone = (e: unknown) => e instanceof GoogleApiError && (e.status === 404 || e.status === 410);

/**
 * Creates captured items: events in Google Calendar, tasks in Google Tasks, mirrored locally.
 * If Google is not configured or the write fails, the item is saved locally so nothing is lost.
 */
export class ItemCreator {
  constructor(private readonly o: ItemCreatorOptions) {}

  async create(item: ResolvedCapture): Promise<CreatedItem> {
    return item.kind === 'event' ? this.createEvent(item) : this.createTask(item);
  }

  private async createEvent(
    item: Extract<ResolvedCapture, { kind: 'event' }>,
  ): Promise<CreatedItem> {
    const { db, now, timeZone, calendar } = this.o;
    let fallbackNote: string | null = null;
    if (calendar) {
      try {
        const g = await calendar.client.insertEvent(calendar.calendarId, {
          summary: item.title,
          description: item.notes,
          ...(item.allDay
            ? { start: { date: item.startDate! }, end: { date: item.endDate! } }
            : {
                start: { dateTime: item.start.toISOString(), timeZone },
                end: { dateTime: item.end.toISOString(), timeZone },
              }),
        });
        const normalized = normalizeGoogleEvent(g, {
          calendarId: calendar.calendarId,
          calendarName: null,
          calendarTimeZone: timeZone,
          appTimeZone: timeZone,
        });
        if (normalized) upsertItems(db, [normalized], now());
        const externalId = eventExternalId(calendar.calendarId, g.id);
        const row = db
          .select({ id: calendarEvents.id })
          .from(calendarEvents)
          .where(
            and(
              eq(calendarEvents.source, 'google_calendar'),
              eq(calendarEvents.externalId, externalId),
            ),
          )
          .get();
        if (row) {
          return {
            kind: 'event',
            source: 'google_calendar',
            itemId: row.id,
            externalId,
            title: item.title,
            fallbackNote,
          };
        }
      } catch (e) {
        log.warn('google calendar insert failed; saving locally', { error: sanitizeError(e) });
        fallbackNote = 'saved in Planner; Google Calendar was unavailable';
      }
    }
    const id = randomUUID();
    const at = now();
    db.insert(calendarEvents)
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
    return {
      kind: 'event',
      source: 'local',
      itemId: id,
      externalId: id,
      title: item.title,
      fallbackNote,
    };
  }

  private async createTask(item: Extract<ResolvedCapture, { kind: 'task' }>): Promise<CreatedItem> {
    const { db, now, tasks: gtasks } = this.o;
    let fallbackNote: string | null = null;
    const at = now();
    if (gtasks) {
      try {
        const g = await gtasks.insert({
          title: item.title,
          notes: item.notes,
          dueDate: item.dueDate,
        });
        const externalId = googleTaskExternalId(DEFAULT_TASK_LIST, g.id);
        upsertItems(
          db,
          [
            {
              kind: 'task',
              data: {
                source: 'google_tasks',
                externalId,
                title: item.title,
                notes: item.notes,
                due: item.due,
                dueAllDay: item.dueAllDay,
                status: 'todo',
                url: g.webViewLink ?? null,
                updatedAt: g.updated ? new Date(g.updated) : at,
              },
            },
          ],
          at,
        );
        const row = db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.source, 'google_tasks'), eq(tasks.externalId, externalId)))
          .get()!;
        return {
          kind: 'task',
          source: 'google_tasks',
          itemId: row.id,
          externalId,
          title: item.title,
          fallbackNote,
        };
      } catch (e) {
        log.warn('google tasks insert failed; saving locally', { error: sanitizeError(e) });
        fallbackNote = 'saved in Planner; Google Tasks was unavailable';
      }
    }
    const id = randomUUID();
    const top =
      db
        .select({ v: max(tasks.sortOrder) })
        .from(tasks)
        .get()?.v ?? 0;
    db.insert(tasks)
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
    return {
      kind: 'task',
      source: 'local',
      itemId: id,
      externalId: id,
      title: item.title,
      fallbackNote,
    };
  }

  /** Deletes a captured item upstream (if any) and locally. Already-gone upstream is fine. */
  async remove(c: CaptureRow): Promise<void> {
    const { db, calendar, tasks: gtasks } = this.o;
    try {
      if (c.source === 'google_calendar' && calendar) {
        const { calendarId, eventId } = splitEventExternalId(c.externalId);
        await calendar.client.deleteEvent(calendarId, eventId);
      } else if (c.source === 'google_tasks' && gtasks) {
        const { list, id } = splitGoogleTaskExternalId(c.externalId);
        await gtasks.delete(id, list);
      }
    } catch (e) {
      if (!gone(e)) throw e;
    }
    const table = c.kind === 'event' ? calendarEvents : tasks;
    db.delete(table).where(eq(table.id, c.itemId)).run();
  }

  /** Marks a task done upstream (Google Tasks) and locally; synced read-only sources stay local. */
  async complete(t: TaskRow): Promise<void> {
    const { db, now, tasks: gtasks } = this.o;
    if (t.source === 'google_tasks' && gtasks) {
      const { list, id } = splitGoogleTaskExternalId(t.externalId);
      await gtasks.complete(id, list);
    }
    const at = now();
    db.update(tasks)
      .set({
        status: 'done',
        completedAt: at,
        updatedAt: at,
        statusSetLocally: t.source !== 'local' && t.source !== 'google_tasks',
      })
      .where(eq(tasks.id, t.id))
      .run();
  }
}
