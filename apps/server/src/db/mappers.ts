import type { Announcement, CalendarEvent, Course, SyncStatus, Task } from '@planner/shared';
import type { AnnouncementRow, CourseRow, EventRow, SyncStateRow, TaskRow } from './schema';

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export function toEventJson(r: EventRow): CalendarEvent {
  return {
    ...r,
    start: iso(r.start),
    end: iso(r.end),
    updatedAt: iso(r.updatedAt),
    syncedAt: iso(r.syncedAt),
  };
}

export function toTaskJson(r: TaskRow): Task {
  return {
    ...r,
    due: isoOrNull(r.due),
    createdAt: iso(r.createdAt),
    completedAt: isoOrNull(r.completedAt),
    updatedAt: iso(r.updatedAt),
    syncedAt: iso(r.syncedAt),
  };
}

export function toSyncStatusJson(
  name: string,
  r: SyncStateRow | undefined,
  running: boolean,
): SyncStatus {
  return {
    source: name,
    cursor: r?.cursor ?? null,
    lastSyncAt: isoOrNull(r?.lastSyncAt ?? null),
    lastError: r?.lastError ?? null,
    consecutiveFailures: r?.consecutiveFailures ?? 0,
    nextRunAt: isoOrNull(r?.nextRunAt ?? null),
    running,
  };
}

export function toCourseJson(r: CourseRow, includeGrades: boolean): Course {
  return {
    ...r,
    currentScore: includeGrades ? r.currentScore : null,
    currentGrade: includeGrades ? r.currentGrade : null,
    syncedAt: iso(r.syncedAt),
  };
}

export function toAnnouncementJson(r: AnnouncementRow): Announcement {
  return { ...r, postedAt: iso(r.postedAt), syncedAt: iso(r.syncedAt) };
}
