import { z } from 'zod';

/** Where an item came from. `local` = created in this app. */
export const SOURCES = ['google_calendar', 'google_tasks', 'canvas', 'local'] as const;
export const SourceSchema = z.enum(SOURCES);
export type Source = z.infer<typeof SourceSchema>;

export const TASK_STATUSES = ['todo', 'doing', 'done'] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const PRIORITIES = ['low', 'medium', 'high'] as const;
export const PrioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof PrioritySchema>;

/** Timestamps cross the wire as ISO 8601 strings; the server stores UTC epoch ms. */
export const IsoDateTime = z.iso.datetime({ offset: true });

export const CalendarEventSchema = z.object({
  id: z.string(),
  source: SourceSchema,
  externalId: z.string(),
  title: z.string(),
  start: IsoDateTime,
  /** Exclusive. For all-day events: midnight (APP_TIMEZONE) after the last day. */
  end: IsoDateTime,
  allDay: z.boolean(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  calendarName: z.string().nullable(),
  url: z.string().nullable(),
  updatedAt: IsoDateTime,
  syncedAt: IsoDateTime,
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  source: SourceSchema,
  externalId: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  due: IsoDateTime.nullable(),
  /** True when only the date matters (`due` is midnight in APP_TIMEZONE). */
  dueAllDay: z.boolean(),
  status: TaskStatusSchema,
  /** Status was changed in this app; sync must not overwrite it (e.g. Canvas is read-only). */
  statusSetLocally: z.boolean(),
  priority: PrioritySchema.nullable(),
  courseOrProject: z.string().nullable(),
  url: z.string().nullable(),
  sortOrder: z.number(),
  createdAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime,
  syncedAt: IsoDateTime,
});
export type Task = z.infer<typeof TaskSchema>;

const Title = z.string().trim().min(1).max(500);

const TaskFields = z.object({
  title: Title,
  notes: z.string().max(10_000).nullish(),
  due: IsoDateTime.nullish(),
  dueAllDay: z.boolean(),
  status: TaskStatusSchema,
  priority: PrioritySchema.nullish(),
  courseOrProject: z.string().max(200).nullish(),
  url: z.url().nullish(),
});

export const NewTaskSchema = TaskFields.extend({
  dueAllDay: TaskFields.shape.dueAllDay.default(true),
  status: TaskFields.shape.status.default('todo'),
});
export type NewTask = z.input<typeof NewTaskSchema>;

/** No defaults here: only the keys actually sent are applied. */
export const TaskPatchSchema = TaskFields.partial()
  .extend({ sortOrder: z.number().optional() })
  .strict();
export type TaskPatch = z.input<typeof TaskPatchSchema>;

export const SUGGESTION_STATUSES = ['pending', 'accepted', 'dismissed'] as const;
export const SuggestionSchema = z.object({
  id: z.string(),
  sourceMessageRef: z.string(),
  proposedTitle: z.string(),
  proposedDue: IsoDateTime.nullable(),
  confidence: z.number().min(0).max(1),
  status: z.enum(SUGGESTION_STATUSES),
  createdAt: IsoDateTime,
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

export const SyncStatusSchema = z.object({
  source: z.string(),
  cursor: z.string().nullable(),
  lastSyncAt: IsoDateTime.nullable(),
  lastError: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  nextRunAt: IsoDateTime.nullable(),
  running: z.boolean(),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

export const MAX_AGENDA_RANGE_DAYS = 92;

export const AgendaQuerySchema = z
  .object({
    from: IsoDateTime,
    to: IsoDateTime,
    includeOverdue: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  })
  .refine((q) => Date.parse(q.from) < Date.parse(q.to), { message: '`from` must be before `to`' })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= MAX_AGENDA_RANGE_DAYS * 86_400_000, {
    message: `range must be at most ${MAX_AGENDA_RANGE_DAYS} days`,
  });
export type AgendaQuery = z.input<typeof AgendaQuerySchema>;

export const AgendaItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), at: IsoDateTime, item: CalendarEventSchema }),
  z.object({
    kind: z.literal('task'),
    at: IsoDateTime,
    overdue: z.boolean(),
    item: TaskSchema,
  }),
]);
export type AgendaItem = z.infer<typeof AgendaItemSchema>;

export const AgendaResponseSchema = z.object({ items: z.array(AgendaItemSchema) });
export type AgendaResponse = z.infer<typeof AgendaResponseSchema>;

export const IsoDate = z.iso.date();

/** When an event happens: all-day dates (end exclusive) or timed instants. */
export const EventTimesSchema = z.union([
  z
    .object({ allDay: z.literal(true), startDate: IsoDate, endDate: IsoDate })
    .strict()
    .refine((t) => t.startDate < t.endDate, {
      message: '`endDate` (exclusive) must be after `startDate`',
    }),
  z
    .object({ allDay: z.literal(false), start: IsoDateTime, end: IsoDateTime })
    .strict()
    .refine((t) => Date.parse(t.start) < Date.parse(t.end), {
      message: '`end` must be after `start`',
    }),
]);
export type EventTimes = z.infer<typeof EventTimesSchema>;

/**
 * Writes to an external calendar must be confirmed explicitly. Without `confirm: true` the
 * server answers 400 `confirmation_required` with a preview and changes nothing.
 */
const Confirm = z.boolean().optional();

export const NewEventSchema = z
  .object({
    title: Title,
    when: EventTimesSchema,
    location: z.string().max(500).nullish(),
    description: z.string().max(8000).nullish(),
    calendarId: z.string().min(1).optional(),
    confirm: Confirm,
  })
  .strict();
export type NewEvent = z.input<typeof NewEventSchema>;

export const EventPatchSchema = z
  .object({
    title: Title.optional(),
    when: EventTimesSchema.optional(),
    location: z.string().max(500).nullish(),
    description: z.string().max(8000).nullish(),
    confirm: Confirm,
  })
  .strict();
export type EventPatch = z.input<typeof EventPatchSchema>;

export const ConfirmSchema = z.object({ confirm: Confirm }).strict();
