import type {
  CanvasAnnouncement,
  CanvasAssignment,
  CanvasCalendarEvent,
  CanvasCourse,
} from '@planner/canvas';
import {
  addDays,
  startOfDateInZone,
  type SubmissionStatus,
  type TaskStatus,
} from '@planner/shared';
import type { AnnouncementInput, CourseInput, EventInput, TaskInput } from '../sync/types';

/** Shared by the REST and iCal paths so switching between them keeps the same rows. */
export const canvasIds = {
  assignment: (id: string) => `assignment-${id}`,
  event: (id: string) => `event-${id}`,
  course: (id: string) => `course-${id}`,
  announcement: (id: string) => `announcement-${id}`,
};

/**
 * Most specific state first: excused > missing > late > graded > submitted > unsubmitted.
 * (`late` implies it was turned in; `missing` means past due with nothing turned in.)
 */
export function submissionStatus(a: CanvasAssignment): SubmissionStatus {
  const s = a.submission;
  if (!s) return 'unsubmitted';
  if (s.excused) return 'excused';
  if (s.missing) return 'missing';
  if (s.late) return 'late';
  if (s.workflow_state === 'graded') return 'graded';
  if (s.workflow_state === 'submitted' || s.workflow_state === 'pending_review' || s.submitted_at) {
    return 'submitted';
  }
  return 'unsubmitted';
}

export function taskStatusFor(s: SubmissionStatus): TaskStatus {
  return s === 'unsubmitted' || s === 'missing' ? 'todo' : 'done';
}

export function assignmentToTask(a: CanvasAssignment, courseName: string, now: Date): TaskInput {
  const sub = submissionStatus(a);
  const status = taskStatusFor(sub);
  return {
    source: 'canvas',
    externalId: canvasIds.assignment(a.id),
    title: a.name.trim() || '(untitled assignment)',
    due: a.due_at ? new Date(a.due_at) : null,
    dueAllDay: false,
    status,
    courseOrProject: courseName,
    url: a.html_url,
    pointsPossible: a.points_possible ?? null,
    submissionStatus: sub,
    createdAt: a.created_at ? new Date(a.created_at) : now,
    completedAt:
      status === 'done' && a.submission?.submitted_at ? new Date(a.submission.submitted_at) : null,
    updatedAt: a.updated_at ? new Date(a.updated_at) : now,
  };
}

export function canvasEventToEvent(
  e: CanvasCalendarEvent,
  courseName: string | null,
  appTimeZone: string,
  now: Date,
): EventInput | null {
  if (e.workflow_state === 'deleted') return null;
  let start: Date;
  let end: Date;
  const allDay = Boolean(e.all_day && e.all_day_date);
  if (allDay) {
    start = startOfDateInZone(e.all_day_date!, appTimeZone);
    end = startOfDateInZone(addDays(e.all_day_date!, 1), appTimeZone);
  } else {
    if (!e.start_at) return null;
    start = new Date(e.start_at);
    end = e.end_at ? new Date(e.end_at) : start;
  }
  return {
    source: 'canvas',
    externalId: canvasIds.event(e.id),
    title: e.title.trim() || '(untitled event)',
    start,
    end,
    allDay,
    location: e.location_name || null,
    // Descriptions are instructor-authored HTML; we keep titles and times only.
    description: null,
    calendarName: courseName,
    url: e.html_url ?? null,
    updatedAt: e.updated_at ? new Date(e.updated_at) : now,
  };
}

export function courseToInput(
  c: CanvasCourse,
  baseUrl: string,
  includeGrades: boolean,
): CourseInput {
  const student = c.enrollments?.find(
    (en) => en.type === 'student' || en.type === 'StudentEnrollment',
  );
  return {
    source: 'canvas',
    externalId: canvasIds.course(c.id),
    name: c.name,
    courseCode: c.course_code ?? null,
    termName: c.term?.name ?? null,
    currentScore: includeGrades ? (student?.computed_current_score ?? null) : null,
    currentGrade: includeGrades ? (student?.computed_current_grade ?? null) : null,
    url: new URL(`/courses/${c.id}`, baseUrl).toString(),
  };
}

export function announcementToInput(
  a: CanvasAnnouncement,
  courseName: string | null,
): AnnouncementInput | null {
  if (!a.posted_at) return null;
  return {
    source: 'canvas',
    externalId: canvasIds.announcement(a.id),
    title: a.title.trim() || '(untitled announcement)',
    courseName,
    postedAt: new Date(a.posted_at),
    url: a.html_url ?? null,
  };
}
