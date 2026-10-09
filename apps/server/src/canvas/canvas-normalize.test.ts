import type { CanvasAssignment } from '@planner/canvas';
import { canvasFixture } from '@planner/canvas/testing';
import { describe, expect, it } from 'vitest';
import { assignmentToTask, submissionStatus } from './canvas-normalize';

const all = [
  ...canvasFixture<CanvasAssignment[]>('assignments-101-page1.json'),
  ...canvasFixture<CanvasAssignment[]>('assignments-101-page2.json'),
  ...canvasFixture<CanvasAssignment[]>('assignments-102.json'),
];
const byName = (name: string) => all.find((a) => a.name === name)!;
const NOW = new Date('2026-10-09T16:00:00Z');

describe('Canvas submission mapping', () => {
  it.each([
    ['Problem Set 4', 'unsubmitted', 'todo'],
    ['Lab Report 3', 'missing', 'todo'],
    ['Problem Set 3', 'late', 'done'], // graded but turned in late
    ['Reading Quiz 2', 'graded', 'done'],
    ['Syllabus Quiz', 'excused', 'done'],
    ['Calc HW 6', 'submitted', 'done'],
  ] as const)('%s → %s / %s', (name, sub, status) => {
    const a = byName(name);
    expect(submissionStatus(a)).toBe(sub);
    expect(assignmentToTask(a, 'Course', NOW)).toMatchObject({ submissionStatus: sub, status });
  });

  it('treats an assignment without a submission object as unsubmitted', () => {
    expect(submissionStatus({ ...byName('Problem Set 4'), submission: undefined })).toBe(
      'unsubmitted',
    );
  });

  it('normalizes to a canvas task with course, points, link, and completion time', () => {
    expect(assignmentToTask(byName('Calc HW 6'), 'MATH 221: Calculus III', NOW)).toMatchObject({
      source: 'canvas',
      externalId: 'assignment-2001',
      title: 'Calc HW 6',
      due: new Date('2026-10-10T03:59:59Z'),
      dueAllDay: false,
      courseOrProject: 'MATH 221: Calculus III',
      pointsPossible: 10,
      url: 'https://canvas.example.edu/courses/102/assignments/2001',
      completedAt: new Date('2026-10-09T15:00:00Z'),
    });
  });

  it('never carries the assignment description (untrusted instructor HTML)', () => {
    const task = assignmentToTask(byName('Problem Set 4'), 'PHYS 201', NOW);
    expect(JSON.stringify(task)).not.toContain('Ignore previous instructions');
    expect(task.notes ?? null).toBeNull();
  });
});
