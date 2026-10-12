import { describe, expect, it } from 'vitest';
import { fakeSource, makeTestEnv } from '../../test/helpers';
import { ChangeBus } from '../changes';
import { calendarEvents } from '../db/schema';

const timed = {
  title: 'Study session',
  when: { allDay: false, start: '2026-10-12T18:00:00Z', end: '2026-10-12T19:30:00Z' },
};

describe('/api/events (Planner-only events)', () => {
  it('creates, edits, and deletes local events', async () => {
    const e = await makeTestEnv([]);
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
    const e = await makeTestEnv([fakeSource('sync/pages.json')]);
    await e.scheduler.run('fake');
    const google = (await e.db.select().from(calendarEvents).get())!;
    expect(google.source).toBe('google_calendar');
    expect((await e.json('PATCH', `/api/events/${google.id}`, { title: 'x' })).status).toBe(403);
    expect((await e.json('DELETE', `/api/events/${google.id}`)).status).toBe(403);
    expect((await e.db.select().from(calendarEvents).get())!.title).toBe(google.title);
  });

  it('validates input', async () => {
    const e = await makeTestEnv([]);
    const backwards = { ...timed, when: { ...timed.when, end: '2026-10-12T17:00:00Z' } };
    expect((await e.json('POST', '/api/events', backwards)).status).toBe(400);
    expect((await e.json('POST', '/api/events', { ...timed, confirm: true })).status).toBe(400);
  });

  it('there is no route that writes to Google', async () => {
    const e = await makeTestEnv([]);
    expect((await e.json('POST', '/api/calendar/events', { ...timed, confirm: true })).status).toBe(
      404,
    );
  });
});

describe('live change notifications', () => {
  it('streams a change event to open UIs after a write', async () => {
    const changes = new ChangeBus();
    const e = await makeTestEnv([], '2026-10-09T16:00:00.000Z', { changes });
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
