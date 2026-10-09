import { SOURCES, PRIORITIES, SUGGESTION_STATUSES, TASK_STATUSES } from '@planner/shared';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** All timestamps are UTC epoch milliseconds. */
const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });
const bool = (name: string) => integer(name, { mode: 'boolean' });

export const calendarEvents = sqliteTable(
  'calendar_events',
  {
    id: text('id').primaryKey(),
    source: text('source', { enum: SOURCES }).notNull(),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    start: ts('start').notNull(),
    end: ts('end').notNull(),
    allDay: bool('all_day').notNull().default(false),
    location: text('location'),
    description: text('description'),
    calendarName: text('calendar_name'),
    url: text('url'),
    updatedAt: ts('updated_at').notNull(),
    syncedAt: ts('synced_at').notNull(),
  },
  (t) => [
    uniqueIndex('events_source_ext_uq').on(t.source, t.externalId),
    index('events_range_idx').on(t.start, t.end),
  ],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    source: text('source', { enum: SOURCES }).notNull(),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    notes: text('notes'),
    due: ts('due'),
    dueAllDay: bool('due_all_day').notNull().default(true),
    status: text('status', { enum: TASK_STATUSES }).notNull().default('todo'),
    statusSetLocally: bool('status_set_locally').notNull().default(false),
    priority: text('priority', { enum: PRIORITIES }),
    courseOrProject: text('course_or_project'),
    url: text('url'),
    sortOrder: real('sort_order').notNull().default(0),
    createdAt: ts('created_at').notNull(),
    completedAt: ts('completed_at'),
    updatedAt: ts('updated_at').notNull(),
    syncedAt: ts('synced_at').notNull(),
  },
  (t) => [
    uniqueIndex('tasks_source_ext_uq').on(t.source, t.externalId),
    index('tasks_due_idx').on(t.due),
  ],
);

export const suggestions = sqliteTable('suggestions', {
  id: text('id').primaryKey(),
  /** e.g. "telegram:12345" — a reference, never the raw message text. */
  sourceMessageRef: text('source_message_ref').notNull(),
  proposedTitle: text('proposed_title').notNull(),
  proposedDue: ts('proposed_due'),
  confidence: real('confidence').notNull(),
  status: text('status', { enum: SUGGESTION_STATUSES }).notNull().default('pending'),
  createdAt: ts('created_at').notNull(),
});

export const syncState = sqliteTable('sync_state', {
  source: text('source').primaryKey(),
  cursor: text('cursor'),
  lastSyncAt: ts('last_sync_at'),
  /** Sanitized: never contains tokens or URLs with credentials. */
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  nextRunAt: ts('next_run_at'),
});

export type EventRow = typeof calendarEvents.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type SyncStateRow = typeof syncState.$inferSelect;
