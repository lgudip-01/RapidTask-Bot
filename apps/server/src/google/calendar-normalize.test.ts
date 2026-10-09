import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/helpers';
import type { GEvent } from './calendar-client';
import { normalizeGoogleEvent, type NormalizeContext } from './calendar-normalize';

const cases = loadFixture<Record<string, GEvent>>('google/event-cases.json');
const ctx: NormalizeContext = {
  calendarId: 'primary',
  calendarName: 'owner@example.com',
  calendarTimeZone: 'America/New_York',
  appTimeZone: 'America/New_York',
};

function event(name: string) {
  const item = normalizeGoogleEvent(cases[name]!, ctx);
  if (item?.kind !== 'event') throw new Error(`expected an event for ${name}`);
  return {
    ...item.data,
    start: item.data.start.toISOString(),
    end: item.data.end.toISOString(),
  };
}

describe('normalizeGoogleEvent', () => {
  it('anchors a single all-day event to midnight New York, end exclusive', () => {
    expect(event('allDaySingle')).toMatchObject({
      externalId: 'primary/allday1',
      title: "Mom's birthday",
      allDay: true,
      start: '2026-10-09T04:00:00.000Z',
      end: '2026-10-10T04:00:00.000Z',
      calendarName: 'owner@example.com',
      url: 'https://www.google.com/calendar/event?eid=YWxsZGF5MQ',
    });
  });

  it('handles an all-day span across the DST change (EDT → EST)', () => {
    expect(event('allDayAcrossDst')).toMatchObject({
      start: '2026-10-31T04:00:00.000Z',
      end: '2026-11-03T05:00:00.000Z',
    });
  });

  it('keeps recurring instances distinct and preserves local wall time across DST', () => {
    const before = event('recurringInstance');
    const after = event('recurringInstanceAfterDst');
    expect(before.externalId).toBe('primary/phys201_20261012T130000Z');
    expect(before).toMatchObject({
      start: '2026-10-12T13:00:00.000Z',
      end: '2026-10-12T14:15:00.000Z',
      location: 'Hall B',
      allDay: false,
    });
    // 9:00 in New York both times; the UTC hour shifts by one.
    expect(after).toMatchObject({
      start: '2026-11-02T14:00:00.000Z',
      end: '2026-11-02T15:15:00.000Z',
    });
  });

  it('turns a cancelled instance into a delete of exactly that instance', () => {
    expect(normalizeGoogleEvent(cases.cancelledInstance!, ctx)).toEqual({
      kind: 'delete',
      entity: 'event',
      source: 'google_calendar',
      externalId: 'primary/phys201_20261014T130000Z',
    });
  });

  it('stores UTC for events in other time zones', () => {
    expect(event('londonTimed')).toMatchObject({
      start: '2026-10-20T14:00:00.000Z',
      end: '2026-10-20T15:00:00.000Z',
    });
    expect(event('noOffsetLosAngeles')).toMatchObject({
      start: '2026-10-21T16:00:00.000Z',
      end: '2026-10-21T17:00:00.000Z',
    });
    expect(event('utc')).toMatchObject({
      start: '2026-10-22T18:00:00.000Z',
      title: 'Deploy window',
    });
  });

  it('fills a placeholder title and skips working-location entries', () => {
    expect(event('noTitle').title).toBe('(no title)');
    expect(normalizeGoogleEvent(cases.workingLocation!, ctx)).toBeNull();
  });
});
