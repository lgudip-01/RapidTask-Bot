import { canvasFixtureText } from '@planner/canvas/testing';
import { describe, expect, it } from 'vitest';
import { fakeFetch } from '../../test/fake-fetch';
import { makeTestEnv } from '../../test/helpers';
import { calendarEvents, tasks } from '../db/schema';
import { CanvasIcsSource, splitCourseSuffix } from './canvas-ics-source';
import { parseIcs } from './ics';

const FEED = 'https://canvas.example.edu/feeds/calendars/user_SECRETTOKEN.ics';
const ics = canvasFixtureText('feed.ics');

describe('Canvas iCal fallback', () => {
  it('parses folded lines, escapes, all-day dates, UTC and TZID times', () => {
    const evs = parseIcs(ics, 'America/New_York');
    expect(evs.map((e) => e.uid)).toEqual([
      'event-assignment-1001',
      'event-calendar-event-502',
      'event-calendar-event-501',
    ]);
    expect(evs[0]!.start).toEqual({ instant: new Date('2026-10-10T03:59:59Z') });
    expect(evs[1]!.start).toEqual({ date: '2026-10-13' });
    expect(evs[2]!.summary).toBe(
      'PHYS 201 Midterm Review with a very long title that is folded across lines [PHYS 201]',
    );
    expect(evs[2]!.start).toEqual({ instant: new Date('2026-10-15T22:00:00Z') }); // 5pm CDT
  });

  it('splits the course suffix from the title', () => {
    expect(splitCourseSuffix('Problem Set 4 [PHYS 201]')).toEqual({
      title: 'Problem Set 4',
      course: 'PHYS 201',
    });
    expect(splitCourseSuffix('Office hours')).toEqual({ title: 'Office hours', course: null });
  });

  it('syncs assignments as tasks and other entries as events with REST-compatible ids', async () => {
    const api = fakeFetch(() => ({ status: 200, json: undefined }));
    const fetchIcs = (async (input: string | URL | Request, init?: RequestInit) => {
      await api(input, init);
      return new Response(ics, { status: 200, headers: { 'content-type': 'text/calendar' } });
    }) as typeof fetch;
    const source = new CanvasIcsSource(
      { feedUrl: FEED, appTimeZone: 'America/New_York', intervalMs: 1_800_000 },
      fetchIcs,
    );
    const env = await makeTestEnv([source]);

    expect(await env.scheduler.run('canvas')).toMatchObject({ ok: true, upserted: 3 });
    expect(await env.db.select().from(tasks).all()).toEqual([
      expect.objectContaining({
        externalId: 'assignment-1001',
        title: 'Problem Set 4',
        courseOrProject: 'PHYS 201',
        status: 'todo',
        dueAllDay: false,
      }),
    ]);
    const evs = await env.db.select().from(calendarEvents).all();
    expect(evs.map((e) => e.externalId).sort()).toEqual(['event-501', 'event-502']);
    expect(evs.find((e) => e.externalId === 'event-502')).toMatchObject({
      allDay: true,
      title: 'No class — Fall break',
    });
  });

  it('reports feed errors without the secret URL', async () => {
    const source = new CanvasIcsSource(
      { feedUrl: FEED, appTimeZone: 'America/New_York', intervalMs: 1 },
      (async () => new Response('nope', { status: 401 })) as typeof fetch,
    );
    const env = await makeTestEnv([source]);
    const out = await env.scheduler.run('canvas');
    expect(out).toEqual({ ok: false, error: 'Error: Canvas calendar feed returned 401' });
    expect(JSON.stringify(await env.scheduler.status())).not.toContain('SECRETTOKEN');
  });
});
