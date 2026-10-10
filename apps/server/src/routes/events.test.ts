import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fakeSource, makeTestEnv } from '../../test/helpers';
import { ChangeBus } from '../changes';
import { calendarEvents, tasks } from '../db/schema';

const timed = {
  title: 'Study session',
  when: { allDay: false, start: '2026-10-12T18:00:00Z', end: '2026-10-12T19:30:00Z' },
};

describe('/api/events (Planner-only events)', () => {
  it('creates, edits, and deletes local events', async () => {
    const e = makeTestEnv([]);
    const created = await e.json('POST', '/api/events', { ...timed, location: 'Library' });
    expect(created.status).toBe(201);
    expect(created.body.event).toMatchObject({
      source: 'local',
      title: 'Study session',
      allDay: false,
    });
    const id = created.body.event.id;

    const moved = await e.json('PATCH', `/api/events/${id}`, {
      title: 'Exam prep',
      when: { allDay: true, startDate: '2026-10-13', endDate: '2026-10-14' },
    });
    expect(moved.body.event).toMatchObject({
      title: 'Exam prep',
      allDay: true,
      start: '2026-10-13T04:00:00.000Z',
      end: '2026-10-14T04:00:00.000Z',
      location: 'Library',
    });

    expect((await e.json('DELETE', `/api/events/${id}`)).status).toBe(204);
    expect((await e.json('GET', `/api/events/${id}`)).status).toBe(404);
  });

  it('refuses to edit or delete Google or Canvas events (read-only)', async () => {
    const e = makeTestEnv([fakeSource('sync/pages.json')]);
    await e.scheduler.run('fake');
    const google = e.db.select().from(calendarEvents).get()!;
    expect(google.source).toBe('google_calendar');
    expect((await e.json('PATCH', `/api/events/${google.id}`, { title: 'x' })).status).toBe(403);
    expect((await e.json('DELETE', `/api/events/${google.id}`)).status).toBe(403);
    expect(e.db.select().from(calendarEvents).get()!.title).toBe(google.title);
  });

  it('validates input', async () => {
    const e = makeTestEnv([]);
    const backwards = { ...timed, when: { ...timed.when, end: '2026-10-12T17:00:00Z' } };
    expect((await e.json('POST', '/api/events', backwards)).status).toBe(400);
    expect((await e.json('POST', '/api/events', { ...timed, confirm: true })).status).toBe(400);
  });

  it('there is no route that writes to Google', async () => {
    const e = makeTestEnv([]);
    expect((await e.json('POST', '/api/calendar/events', { ...timed, confirm: true })).status).toBe(
      404,
    );
  });
});

describe('live change notifications', () => {
  it('streams a change event to open UIs after a write', async () => {
    const changes = new ChangeBus();
    const e = makeTestEnv([], '2026-10-09T16:00:00.000Z', { changes });
    const ac = new AbortController();
    const res = await e.app.request('/api/stream', { signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value);

    expect(await read()).toContain('event: ping');
    await e.json('POST', '/api/tasks', { title: 'From another device' });
    expect(await read()).toMatch(/event: change\n.*"topic":"items"/s);
    ac.abort();
    await reader.cancel();
  });
});

describe('migration 0005: Google Tasks rows become Planner tasks', () => {
  it('converts google_tasks rows and their captures to local', () => {
    const e = makeTestEnv([]);
    const raw = e.db.$client;
    const at = Date.parse('2026-10-09T16:00:00Z');
    raw
      .prepare(
        `INSERT INTO tasks (id, source, external_id, title, due_all_day, status, status_set_locally, url, sort_order, created_at, updated_at, synced_at)
         VALUES ('t1', 'google_tasks', '@default/abc', 'Call landlord', 1, 'todo', 1, 'https://tasks.google.com/x', 0, ?, ?, ?)`,
      )
      .run(at, at, at);
    raw
      .prepare(
        `INSERT INTO inbound_messages (id, channel, provider_message_id, received_at, text_length) VALUES ('m1', 'telegram', '1', ?, 5)`,
      )
      .run(at);
    raw
      .prepare(
        `INSERT INTO captures (id, inbound_id, kind, source, item_id, external_id, title, created_at) VALUES ('c1', 'm1', 'task', 'google_tasks', 't1', '@default/abc', 'Call landlord', ?)`,
      )
      .run(at);

    const sqlFile = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../drizzle/0005_local_only_tasks.sql',
    );
    for (const stmt of fs.readFileSync(sqlFile, 'utf8').split('--> statement-breakpoint'))
      raw.exec(stmt);

    expect(e.db.select().from(tasks).get()).toMatchObject({
      id: 't1',
      source: 'local',
      externalId: 't1',
      title: 'Call landlord',
      statusSetLocally: false,
      url: null,
    });
    expect(raw.prepare(`SELECT source, external_id FROM captures`).get()).toEqual({
      source: 'local',
      external_id: 't1',
    });
  });
});
