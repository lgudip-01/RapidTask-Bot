import { describe, expect, it } from 'vitest';
import {
  addDays,
  dateInZone,
  parseWallDateTime,
  startOfDateInZone,
  zonedParts,
  zonedTimeToUtc,
} from './time';

const NY = 'America/New_York';

describe('time helpers', () => {
  it('converts wall time in New York to UTC in EDT and EST', () => {
    expect(zonedTimeToUtc(NY, 2026, 10, 9, 17, 0).toISOString()).toBe('2026-10-09T21:00:00.000Z');
    expect(zonedTimeToUtc(NY, 2026, 12, 1, 17, 0).toISOString()).toBe('2026-12-01T22:00:00.000Z');
  });

  it('handles the fall-back overlap (Nov 1 2026, 1:30am happens twice) by picking the first', () => {
    expect(zonedTimeToUtc(NY, 2026, 11, 1, 1, 30).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('handles the spring-forward gap (Mar 8 2026, 2:30am does not exist) by moving forward', () => {
    expect(zonedTimeToUtc(NY, 2026, 3, 8, 2, 30).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(zonedParts(zonedTimeToUtc(NY, 2026, 3, 8, 2, 30), NY).hour).toBe(3);
  });

  it('computes midnight for dates on both sides of DST', () => {
    expect(startOfDateInZone('2026-11-01', NY).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(startOfDateInZone('2026-11-02', NY).toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  it('formats the local date of an instant', () => {
    expect(dateInZone(new Date('2026-10-10T03:59:00Z'), NY)).toBe('2026-10-09');
    expect(dateInZone(new Date('2026-10-10T04:00:00Z'), NY)).toBe('2026-10-10');
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('parses date-times with and without offsets', () => {
    expect(parseWallDateTime('2026-10-09T09:00:00-07:00', NY).toISOString()).toBe(
      '2026-10-09T16:00:00.000Z',
    );
    expect(parseWallDateTime('2026-10-09T09:00:00', 'America/Los_Angeles').toISOString()).toBe(
      '2026-10-09T16:00:00.000Z',
    );
  });
});
