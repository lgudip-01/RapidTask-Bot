import { describe, expect, it } from 'vitest';
import { canvasFixture } from '../test/fake-canvas';
import { isCurrentCourse } from './courses';
import type { CanvasCourse } from './types';

const courses = canvasFixture<CanvasCourse[]>('courses.json');
const NOW = new Date('2026-10-09T16:00:00Z');
const byId = (id: string) => courses.find((c) => c.id === id)!;

describe('isCurrentCourse (term filtering)', () => {
  it.each([
    ['101', 'Fall 2026 term contains now', true],
    ['102', 'Fall 2026 term contains now', true],
    ['90', 'Spring 2026 term has ended', false],
    ['120', 'Spring 2027 term has not started', false],
    ['5', 'Default Term with no dates (active enrollment)', true],
    ['88', 'concluded course', false],
    ['95', 'past term but course dates extend through now', true],
  ])('course %s: %s → %s', (id, _why, expected) => {
    expect(isCurrentCourse(byId(id), NOW)).toBe(expected);
  });

  it('drops unpublished and date-restricted courses', () => {
    expect(isCurrentCourse({ ...byId('101'), workflow_state: 'unpublished' }, NOW)).toBe(false);
    expect(isCurrentCourse({ ...byId('101'), access_restricted_by_date: true }, NOW)).toBe(false);
  });
});
