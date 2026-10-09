import type { Priority, Source, TaskStatus } from '@planner/shared';

export interface EventInput {
  source: Source;
  externalId: string;
  title: string;
  start: Date;
  /** Exclusive. */
  end: Date;
  allDay: boolean;
  location?: string | null;
  description?: string | null;
  calendarName?: string | null;
  url?: string | null;
  updatedAt: Date;
}

export interface TaskInput {
  source: Source;
  externalId: string;
  title: string;
  notes?: string | null;
  due?: Date | null;
  dueAllDay: boolean;
  status: TaskStatus;
  priority?: Priority | null;
  courseOrProject?: string | null;
  url?: string | null;
  createdAt?: Date;
  completedAt?: Date | null;
  updatedAt: Date;
}

export type SyncItem =
  | { kind: 'event'; data: EventInput }
  | { kind: 'task'; data: TaskInput }
  | { kind: 'delete'; entity: 'event' | 'task'; source: Source; externalId: string };

export interface SyncBatch {
  items: SyncItem[];
  /** Persisted only if the whole batch is stored successfully. */
  nextCursor: string | null;
  /**
   * The batch is the complete current state of everything this source owns: rows it owns that
   * are absent from the batch are deleted (e.g. after Google's 410 Gone).
   */
  fullResync?: boolean;
}

export interface SyncSource {
  /** Unique; also the `sync_state` key and the `:source` path param. */
  name: string;
  intervalMs: number;
  /** Item sources this SyncSource is authoritative for (used by full re-sync deletes). */
  owns: { events: Source[]; tasks: Source[] };
  fetchSince(cursor: string | null): Promise<SyncBatch>;
}
