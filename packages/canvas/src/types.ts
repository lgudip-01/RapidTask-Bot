/**
 * Subsets of Canvas LMS REST objects that we read. IDs are strings because requests send
 * `Accept: application/json+canvas-string-ids` (Canvas IDs can exceed 2^53).
 */

export interface CanvasTerm {
  id: string;
  name: string;
  start_at: string | null;
  end_at: string | null;
}

export interface CanvasEnrollment {
  type: string;
  enrollment_state?: string;
  computed_current_score?: number | null;
  computed_current_grade?: string | null;
}

export interface CanvasCourse {
  id: string;
  name: string;
  course_code?: string;
  workflow_state?: 'unpublished' | 'available' | 'completed' | 'deleted';
  start_at?: string | null;
  end_at?: string | null;
  concluded?: boolean;
  term?: CanvasTerm;
  enrollments?: CanvasEnrollment[];
  /** Set when the course is restricted (e.g. access_restricted_by_date). */
  access_restricted_by_date?: boolean;
}

export interface CanvasSubmission {
  workflow_state?: 'submitted' | 'unsubmitted' | 'graded' | 'pending_review';
  submitted_at?: string | null;
  late?: boolean;
  missing?: boolean;
  excused?: boolean | null;
  score?: number | null;
  grade?: string | null;
}

export interface CanvasAssignment {
  id: string;
  course_id: string;
  name: string;
  description?: string | null;
  due_at: string | null;
  lock_at?: string | null;
  unlock_at?: string | null;
  points_possible?: number | null;
  html_url: string;
  published?: boolean;
  submission_types?: string[];
  created_at?: string;
  updated_at?: string;
  submission?: CanvasSubmission;
}

export interface CanvasCalendarEvent {
  id: string;
  title: string;
  start_at: string | null;
  end_at: string | null;
  all_day?: boolean;
  all_day_date?: string | null;
  location_name?: string | null;
  description?: string | null;
  html_url?: string;
  context_code: string;
  context_name?: string;
  workflow_state?: string;
  updated_at?: string;
}

export interface CanvasAnnouncement {
  id: string;
  title: string;
  posted_at: string | null;
  html_url?: string;
  context_code: string;
}
