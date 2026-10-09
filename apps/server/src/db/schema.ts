import {
  PRIORITIES,
  SOURCES,
  SUBMISSION_STATUSES,
  SUGGESTION_STATUSES,
  TASK_STATUSES,
} from '@planner/shared';
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
    pointsPossible: real('points_possible'),
    submissionStatus: text('submission_status', { enum: SUBMISSION_STATUSES }),
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

export const courses = sqliteTable(
  'courses',
  {
    id: text('id').primaryKey(),
    source: text('source', { enum: SOURCES }).notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    courseCode: text('course_code'),
    termName: text('term_name'),
    currentScore: real('current_score'),
    currentGrade: text('current_grade'),
    url: text('url'),
    syncedAt: ts('synced_at').notNull(),
  },
  (t) => [uniqueIndex('courses_source_ext_uq').on(t.source, t.externalId)],
);

/** Titles only; announcement bodies are never stored. */
export const announcements = sqliteTable(
  'announcements',
  {
    id: text('id').primaryKey(),
    source: text('source', { enum: SOURCES }).notNull(),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    courseName: text('course_name'),
    postedAt: ts('posted_at').notNull(),
    url: text('url'),
    syncedAt: ts('synced_at').notNull(),
  },
  (t) => [
    uniqueIndex('announcements_source_ext_uq').on(t.source, t.externalId),
    index('announcements_posted_idx').on(t.postedAt),
  ],
);

export type EventRow = typeof calendarEvents.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type SyncStateRow = typeof syncState.$inferSelect;
export type CourseRow = typeof courses.$inferSelect;
export type AnnouncementRow = typeof announcements.$inferSelect;

/**
 * One row per inbound message: dedupe key plus a short audit trail.
 * Never stores the message text (only its length and what we did with it).
 */
export const inboundMessages = sqliteTable(
  'inbound_messages',
  {
    id: text('id').primaryKey(),
    channel: text('channel').notNull(),
    providerMessageId: text('provider_message_id').notNull(),
    receivedAt: ts('received_at').notNull(),
    textLength: integer('text_length').notNull(),
    /** e.g. created_task, created_event, clarify, off_topic, command_undo, rate_limited, error_* */
    outcome: text('outcome').notNull().default('pending'),
    via: text('via'),
    processedAt: ts('processed_at'),
  },
  (t) => [uniqueIndex('inbound_channel_msg_uq').on(t.channel, t.providerMessageId)],
);

/** Items created from messages, so UNDO can remove the latest one. */
export const captures = sqliteTable(
  'captures',
  {
    id: text('id').primaryKey(),
    inboundId: text('inbound_id')
      .notNull()
      .references(() => inboundMessages.id),
    kind: text('kind', { enum: ['task', 'event'] }).notNull(),
    source: text('source', { enum: SOURCES }).notNull(),
    /** Our row id in tasks / calendar_events. */
    itemId: text('item_id').notNull(),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    createdAt: ts('created_at').notNull(),
    undoneAt: ts('undone_at'),
  },
  (t) => [index('captures_created_idx').on(t.createdAt)],
);

export type InboundMessageRow = typeof inboundMessages.$inferSelect;
export type CaptureRow = typeof captures.$inferSelect;

/** App settings as JSON values (single user). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: ts('updated_at').notNull(),
});
