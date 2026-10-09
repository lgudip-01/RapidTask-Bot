import type { Priority, Source, SubmissionStatus, TaskStatus } from '@planner/shared';

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
  pointsPossible?: number | null;
  submissionStatus?: SubmissionStatus | null;
  createdAt?: Date;
  completedAt?: Date | null;
  updatedAt: Date;
}

export interface CourseInput {
  source: Source;
  externalId: string;
  name: string;
  courseCode?: string | null;
  termName?: string | null;
  currentScore?: number | null;
  currentGrade?: string | null;
  url?: string | null;
}

export interface AnnouncementInput {
  source: Source;
  externalId: string;
  title: string;
  courseName?: string | null;
  postedAt: Date;
  url?: string | null;
}

export type SyncEntity = 'event' | 'task' | 'course' | 'announcement';

export type SyncItem =
  | { kind: 'event'; data: EventInput }
  | { kind: 'task'; data: TaskInput }
  | { kind: 'course'; data: CourseInput }
  | { kind: 'announcement'; data: AnnouncementInput }
  | { kind: 'delete'; entity: SyncEntity; source: Source; externalId: string };

export interface SyncBatch {
  items: SyncItem[];
  /** Persisted only if the whole batch is stored successfully. */
  nextCursor: string | null;
  /**
   * The batch is the complete current state of everything this source owns: rows it owns that
   * are absent from the batch are deleted (e.g. after Google's 410 Gone, or every Canvas run).
   */
  fullResync?: boolean;
}

export interface SyncSource {
  /** Unique; also the `sync_state` key and the `:source` path param. */
  name: string;
  intervalMs: number;
  /** Item sources this SyncSource is authoritative for, per entity (used by full re-sync deletes). */
  owns: Partial<Record<SyncEntity, Source[]>>;
  fetchSince(cursor: string | null): Promise<SyncBatch>;
}
