import { describe, expect, it } from 'vitest';
import { fakeSource, makeTestEnv } from '../../test/helpers';
import { calendarEvents, syncState, tasks } from '../db/schema';
import { nextDelay } from './scheduler';
import { applySyncBatch, idsBySource } from './upsert';

const ALL = ['google_calendar', 'canvas', 'google_tasks'] as const;

describe('sync upsert', () => {
  it('is idempotent: re-applying the same page keeps row count and ids, refreshes syncedAt', async () => {
    const src = fakeSource('sync/pages.json');
    const env = makeTestEnv([src]);
    const page0 = await src.fetchSince(null);

    applySyncBatch(env.db, src, page0, env.now());
    const first = idsBySource(env.db, [...ALL]);
    const syncedBefore = env.db.select().from(calendarEvents).all()[0]!.syncedAt;

    env.advance(60_000);
    applySyncBatch(env.db, src, page0, env.now());
    const second = idsBySource(env.db, [...ALL]);

    expect(second).toEqual(first);
    expect(second.events).toHaveLength(2);
    expect(second.tasks).toHaveLength(1);
    const syncedAfter = env.db.select().from(calendarEvents).all()[0]!.syncedAt;
    expect(syncedAfter.getTime() - syncedBefore.getTime()).toBe(60_000);
  });

  it('advances the cursor and applies updates in place and deletes', async () => {
    const src = fakeSource('sync/pages.json');
    const env = makeTestEnv([src]);

    expect(await env.scheduler.run('fake')).toMatchObject({ ok: true, upserted: 3, deleted: 0 });
    const idBefore = idsBySource(env.db, ['google_calendar']).events.find(
      (e) => e.externalId === 'evt-standup',
    )!.id;

    expect(await env.scheduler.run('fake')).toMatchObject({ ok: true, upserted: 2, deleted: 1 });
    const events = env.db.select().from(calendarEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: idBefore, title: 'Standup (moved)' });
    expect(events[0]!.start.toISOString()).toBe('2026-10-09T14:00:00.000Z');

    const task = env.db.select().from(tasks).get()!;
    expect(task.status).toBe('done');
    expect(task.completedAt?.toISOString()).toBe('2026-10-09T20:00:00.000Z');

    expect(env.db.select().from(syncState).get()).toMatchObject({
      source: 'fake',
      cursor: '2',
      lastError: null,
      consecutiveFailures: 0,
    });
  });

  it('keeps a status set locally when the provider sends a different one', async () => {
    const src = fakeSource('sync/pages.json');
    const env = makeTestEnv([src]);
    const page0 = await src.fetchSince(null);
    applySyncBatch(env.db, src, page0, env.now());
    const task = env.db.select().from(tasks).get()!;

    const patched = await env.json('PATCH', `/api/tasks/${task.id}`, { status: 'done' });
    expect(patched.status).toBe(200);
    expect(patched.body.task).toMatchObject({ status: 'done', statusSetLocally: true });

    applySyncBatch(env.db, src, page0, env.now()); // provider still says "todo"
    expect(env.db.select().from(tasks).get()).toMatchObject({
      status: 'done',
      statusSetLocally: true,
      title: 'Calc HW 6',
    });
  });

  it('full re-sync deletes owned rows missing from the batch', async () => {
    const src = fakeSource('sync/pages.json');
    const env = makeTestEnv([src]);
    applySyncBatch(env.db, src, await src.fetchSince(null), env.now());

    const resync = fakeSource('sync/resync.json');
    const res = applySyncBatch(env.db, resync, await resync.fetchSince(null), env.now());

    expect(res).toEqual({ upserted: 1, deleted: 2 }); // evt-fallbreak + canvas asg-101
    expect(
      env.db
        .select()
        .from(calendarEvents)
        .all()
        .map((e) => e.externalId),
    ).toEqual(['evt-standup']);
    expect(env.db.select().from(tasks).all()).toHaveLength(0);
  });

  it('never deletes local tasks during a full re-sync', async () => {
    const resync = fakeSource('sync/resync.json');
    const env = makeTestEnv([resync]);
    await env.json('POST', '/api/tasks', { title: 'Local thing' });
    applySyncBatch(env.db, resync, await resync.fetchSince(null), env.now());
    expect(
      env.db
        .select()
        .from(tasks)
        .all()
        .map((t) => t.source),
    ).toEqual(['local']);
  });

  it('rejects a batch that writes source=local and rolls back the whole batch', async () => {
    const src = fakeSource('sync/pages.json');
    const env = makeTestEnv([src]);
    const page0 = await src.fetchSince(null);
    const task = page0.items[2];
    if (task?.kind !== 'task') throw new Error('fixture: expected a task at index 2');
    const bad = {
      ...page0,
      items: [
        ...page0.items,
        { kind: 'task' as const, data: { ...task.data, source: 'local' as const } },
      ],
    };
    expect(() => applySyncBatch(env.db, src, bad, env.now())).toThrow(/local/);
    expect(env.db.select().from(calendarEvents).all()).toHaveLength(0);
    expect(env.db.select().from(syncState).all()).toHaveLength(0);
  });
});

describe('sync scheduler failures', () => {
  it('records a sanitized error, keeps the cursor, and backs off', async () => {
    const src = fakeSource('sync/pages.json');
    const env = makeTestEnv([src]);
    await env.scheduler.run('fake'); // page 0 ok → cursor "1"
    src.failOn.add(1);

    const out = await env.scheduler.run('fake');
    expect(out.ok).toBe(false);
    const state = env.db.select().from(syncState).get()!;
    expect(state.cursor).toBe('1');
    expect(state.consecutiveFailures).toBe(1);
    expect(state.lastError).toContain('Bearer [redacted]');
    expect(state.lastError).not.toContain('fake-secret-token');
    expect(state.nextRunAt!.getTime() - env.now().getTime()).toBe(2 * src.intervalMs);

    await env.scheduler.run('fake');
    expect(env.db.select().from(syncState).get()!.consecutiveFailures).toBe(2);

    src.failOn.clear();
    expect(await env.scheduler.run('fake')).toMatchObject({ ok: true });
    expect(env.db.select().from(syncState).get()).toMatchObject({
      cursor: '2',
      consecutiveFailures: 0,
      lastError: null,
    });
  });

  it('computes capped, jittered exponential backoff', () => {
    expect(nextDelay(60_000, 0, 3_600_000, 0)).toBe(60_000);
    expect(nextDelay(60_000, 1, 3_600_000, 0)).toBe(120_000);
    expect(nextDelay(60_000, 3, 3_600_000, 0)).toBe(480_000);
    expect(nextDelay(60_000, 10, 3_600_000, 0)).toBe(3_600_000);
    expect(nextDelay(60_000, 10, 3_600_000, 1)).toBe(3_960_000);
  });

  it('schedules runs on start and resumes persisted backoff', async () => {
    const src = fakeSource('sync/pages.json');
    const env = makeTestEnv([src]);
    env.scheduler.start();
    expect(env.timers.at(-1)!.ms).toBe(0);

    env.timers.at(-1)!.fn();
    await new Promise((r) => setImmediate(r));
    expect(src.calls).toBe(1);
    expect(env.timers.at(-1)!.ms).toBe(src.intervalMs);
    env.scheduler.stop();
  });

  it('rejects concurrent runs of the same source', async () => {
    const src = fakeSource('sync/pages.json');
    const env = makeTestEnv([src]);
    const first = env.scheduler.run('fake');
    const second = await env.json('POST', '/api/sync/fake/run');
    expect(second.status).toBe(409);
    await first;
    expect((await env.json('POST', '/api/sync/nope/run')).status).toBe(404);
  });

  it('reports status per source', async () => {
    const src = fakeSource('sync/pages.json');
    const env = makeTestEnv([src]);
    await env.json('POST', '/api/sync/fake/run');
    const res = await env.json('GET', '/api/sync/status');
    expect(res.body.sources).toEqual([
      expect.objectContaining({ source: 'fake', cursor: '1', running: false, lastError: null }),
    ]);
  });
});
