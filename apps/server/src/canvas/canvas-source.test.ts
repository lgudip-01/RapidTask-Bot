import { CanvasClient } from '@planner/canvas';
import { CANVAS_BASE, CANVAS_TOKEN, fakeCanvasApi } from '@planner/canvas/testing';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { makeTestEnv } from '../../test/helpers';
import { announcements, calendarEvents, courses, tasks } from '../db/schema';
import { applySyncBatch } from '../sync/upsert';
import { CanvasSource } from './canvas-source';

function setup(api = fakeCanvasApi(), includeGrades = true) {
  const client = new CanvasClient({
    baseUrl: CANVAS_BASE,
    token: CANVAS_TOKEN,
    fetch: api,
    sleep: async () => {},
  });
  const source = new CanvasSource(client, {
    baseUrl: CANVAS_BASE,
    appTimeZone: 'America/New_York',
    intervalMs: 1_800_000,
    lookbackDays: 30,
    lookaheadDays: 120,
    includeGrades,
    now: () => new Date('2026-10-09T16:00:00Z'),
  });
  return { api, source, env: makeTestEnv([source]) };
}

describe('CanvasSource', () => {
  it('syncs current-term courses, dated assignments, events, and announcement titles', async () => {
    const { env, api } = setup();
    expect(await env.scheduler.run('canvas')).toMatchObject({ ok: true });

    const courseRows = env.db.select().from(courses).all();
    expect(courseRows.map((c) => c.externalId).sort()).toEqual([
      'course-101',
      'course-102',
      'course-5',
      'course-95',
    ]);
    // Only GET requests, only to the Canvas host.
    expect(api.calls.every((c) => c.url.origin === CANVAS_BASE)).toBe(true);
    // No requests for past/future/concluded courses.
    const assignmentPaths = api.calls
      .map((c) => c.url.pathname)
      .filter((p) => p.includes('/assignments'));
    expect(assignmentPaths.some((p) => /courses\/(90|120|88)\//.test(p))).toBe(false);

    const taskRows = env.db.select().from(tasks).all();
    expect(taskRows.map((t) => t.externalId).sort()).toEqual([
      'assignment-1001',
      'assignment-1002',
      'assignment-1003',
      'assignment-1004',
      'assignment-1005',
      'assignment-2001',
    ]);
    expect(taskRows.find((t) => t.externalId === 'assignment-1002')).toMatchObject({
      courseOrProject: 'PHYS 201: Classical Mechanics',
      status: 'todo',
      submissionStatus: 'missing',
      pointsPossible: 30,
    });

    const events = env.db.select().from(calendarEvents).all();
    expect(events.find((e) => e.externalId === 'event-502')).toMatchObject({
      allDay: true,
      calendarName: 'MATH 221: Calculus III',
      description: null,
    });
    expect(events.find((e) => e.externalId === 'event-502')!.start.toISOString()).toBe(
      '2026-10-13T04:00:00.000Z',
    );

    const ann = env.db.select().from(announcements).all();
    expect(ann).toHaveLength(1);
    expect(ann[0]).toMatchObject({
      title: 'Midterm moved to Oct 22',
      courseName: 'PHYS 201: Classical Mechanics',
    });
    expect(JSON.stringify(ann)).not.toContain('must never be stored');
  });

  it('stores grades but the API hides them unless requested', async () => {
    const { env } = setup();
    await env.scheduler.run('canvas');
    const hidden = await env.json('GET', '/api/courses');
    expect(
      hidden.body.courses.find((c: { externalId: string }) => c.externalId === 'course-101'),
    ).toMatchObject({
      currentScore: null,
      currentGrade: null,
    });
    const shown = await env.json('GET', '/api/courses?includeGrades=true');
    expect(
      shown.body.courses.find((c: { externalId: string }) => c.externalId === 'course-101'),
    ).toMatchObject({
      currentScore: 91.4,
      currentGrade: 'A-',
      termName: 'Fall 2026',
    });
  });

  it('does not store grades at all when disabled', async () => {
    const { env } = setup(fakeCanvasApi(), false);
    await env.scheduler.run('canvas');
    expect(
      env.db.select().from(courses).where(eq(courses.externalId, 'course-101')).get(),
    ).toMatchObject({
      currentScore: null,
    });
  });

  it('is idempotent and removes assignments that disappear upstream, keeping local check-offs', async () => {
    const { env } = setup();
    await env.scheduler.run('canvas');
    const ps4 = env.db.select().from(tasks).where(eq(tasks.externalId, 'assignment-1001')).get()!;
    await env.json('PATCH', `/api/tasks/${ps4.id}`, { status: 'done' });

    // Same data again: same ids, local status kept.
    await env.scheduler.run('canvas');
    expect(
      env.db.select().from(tasks).where(eq(tasks.externalId, 'assignment-1001')).get(),
    ).toMatchObject({
      id: ps4.id,
      status: 'done',
      statusSetLocally: true,
    });

    // Course 102 now has no assignments: its task is removed on the next full listing.
    expect(
      env.db
        .select()
        .from(tasks)
        .all()
        .map((t) => t.externalId),
    ).toContain('assignment-2001');
    const next = setup(
      fakeCanvasApi({
        assignments: { '101': ['assignments-101-page1.json', 'assignments-101-page2.json'] },
      }),
    );
    applySyncBatch(env.db, next.source, await next.source.fetchSince(), env.now());
    const remaining = env.db
      .select()
      .from(tasks)
      .all()
      .map((t) => t.externalId);
    expect(remaining).not.toContain('assignment-2001');
    expect(remaining).toContain('assignment-1001');
  });

  it('rejects writes to canvas tasks other than status/sortOrder', async () => {
    const { env } = setup();
    await env.scheduler.run('canvas');
    const t = env.db.select().from(tasks).get()!;
    expect((await env.json('PATCH', `/api/tasks/${t.id}`, { title: 'renamed' })).status).toBe(403);
    expect((await env.json('DELETE', `/api/tasks/${t.id}`)).status).toBe(403);
  });
});
