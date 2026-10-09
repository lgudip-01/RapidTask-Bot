import type { CanvasCourse } from './types';

type Window = { start: string | null | undefined; end: string | null | undefined };

/**
 * Is this an active course in the current term?
 * - concluded, date-restricted, or not `available`: no
 * - otherwise current if the term's window or the course's own window (section/course date
 *   overrides) contains `now`; windows with no dates are ignored
 * - no dates anywhere (e.g. "Default Term" with nulls): yes, since the enrollment is active
 */
export function isCurrentCourse(c: CanvasCourse, now: Date): boolean {
  if (c.concluded) return false;
  if (c.access_restricted_by_date) return false;
  if (c.workflow_state && c.workflow_state !== 'available') return false;

  const t = now.getTime();
  const windows = [
    { start: c.term?.start_at, end: c.term?.end_at },
    { start: c.start_at, end: c.end_at },
  ].filter((w: Window) => w.start || w.end);
  if (windows.length === 0) return true;
  return windows.some(
    (w) => (!w.start || Date.parse(w.start) <= t) && (!w.end || Date.parse(w.end) >= t),
  );
}

export const contextCode = (courseId: string) => `course_${courseId}`;
