import { describe, expect, it } from 'vitest';
import { fakeFetch, staticAuth, type RecordedRequest } from '../../test/fake-fetch';
import { makeTestEnv } from '../../test/helpers';
import { GoogleCalendarClient, type GEvent } from '../google/calendar-client';

function googleStub() {
  let seq = 0;
  return fakeFetch((req: RecordedRequest) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (req.method === 'DELETE') return { status: 204 };
    const id = req.method === 'POST' ? `new${++seq}` : req.url.pathname.split('/').pop()!;
    const ev: GEvent = {
      id,
      status: 'confirmed',
      updated: '2026-10-09T16:00:00.000Z',
      htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
      summary: (body.summary as string) ?? 'Existing',
      start: (body.start as GEvent['start']) ?? { dateTime: '2026-10-10T13:00:00Z' },
      end: (body.end as GEvent['end']) ?? { dateTime: '2026-10-10T14:00:00Z' },
    };
    return { status: 200, json: ev };
  });
}

function env() {
  const api = googleStub();
  const e = makeTestEnv([], '2026-10-09T16:00:00.000Z', {
    calendar: {
      client: new GoogleCalendarClient(staticAuth(), api),
      defaultCalendarId: 'primary',
      appTimeZone: 'America/New_York',
    },
  });
  return { ...e, api };
}

const timed = {
  title: 'Dentist',
  when: { allDay: false, start: '2026-10-10T19:00:00Z', end: '2026-10-10T20:00:00Z' },
};

describe('/api/calendar/events', () => {
  it('refuses to write without confirm and calls nothing', async () => {
    const e = env();
    const res = await e.json('POST', '/api/calendar/events', timed);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: 'confirmation_required',
      preview: { action: 'create', calendarId: 'primary', title: 'Dentist' },
    });
    expect(
      (await e.json('POST', '/api/calendar/events', { ...timed, confirm: false })).status,
    ).toBe(400);
    expect(e.api.calls).toHaveLength(0);
  });

  it('creates a timed event when confirmed and stores it locally', async () => {
    const e = env();
    const res = await e.json('POST', '/api/calendar/events', { ...timed, confirm: true });
    expect(res.status).toBe(201);
    expect(e.api.calls[0]!.method).toBe('POST');
    expect(e.api.calls[0]!.url.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(e.api.calls[0]!.body).toEqual({
      summary: 'Dentist',
      location: null,
      description: null,
      start: { dateTime: '2026-10-10T19:00:00Z', timeZone: 'America/New_York' },
      end: { dateTime: '2026-10-10T20:00:00Z', timeZone: 'America/New_York' },
    });
    expect(res.body.event).toMatchObject({
      source: 'google_calendar',
      externalId: 'primary/new1',
      title: 'Dentist',
      start: '2026-10-10T19:00:00.000Z',
    });
    const agenda = await e.json(
      'GET',
      '/api/agenda?from=2026-10-10T04:00:00Z&to=2026-10-11T04:00:00Z',
    );
    expect(agenda.body.items).toHaveLength(1);
  });

  it('creates an all-day event with date-only times', async () => {
    const e = env();
    const res = await e.json('POST', '/api/calendar/events', {
      title: 'Fall break',
      when: { allDay: true, startDate: '2026-10-13', endDate: '2026-10-15' },
      confirm: true,
    });
    expect(e.api.calls[0]!.body).toMatchObject({
      start: { date: '2026-10-13' },
      end: { date: '2026-10-15' },
    });
    expect(res.body.event).toMatchObject({
      allDay: true,
      start: '2026-10-13T04:00:00.000Z',
      end: '2026-10-15T04:00:00.000Z',
    });
  });

  it('validates event times', async () => {
    const e = env();
    const backwards = { allDay: false, start: '2026-10-10T20:00:00Z', end: '2026-10-10T19:00:00Z' };
    expect(
      (await e.json('POST', '/api/calendar/events', { title: 'x', when: backwards, confirm: true }))
        .status,
    ).toBe(400);
    const mixed = { allDay: true, start: '2026-10-10T19:00:00Z', end: '2026-10-10T20:00:00Z' };
    expect(
      (await e.json('POST', '/api/calendar/events', { title: 'x', when: mixed, confirm: true }))
        .status,
    ).toBe(400);
    expect(e.api.calls).toHaveLength(0);
  });

  it('updates and deletes only with confirm', async () => {
    const e = env();
    const { body } = await e.json('POST', '/api/calendar/events', { ...timed, confirm: true });
    const id = body.event.id;

    expect(
      (await e.json('PATCH', `/api/calendar/events/${id}`, { title: 'Dentist (moved)' })).status,
    ).toBe(400);
    const patched = await e.json('PATCH', `/api/calendar/events/${id}`, {
      title: 'Dentist (moved)',
      confirm: true,
    });
    expect(patched.status).toBe(200);
    expect(e.api.calls.at(-1)!.method).toBe('PATCH');
    expect(e.api.calls.at(-1)!.url.pathname).toBe('/calendar/v3/calendars/primary/events/new1');
    expect(e.api.calls.at(-1)!.body).toEqual({ summary: 'Dentist (moved)' });
    expect(patched.body.event).toMatchObject({ id, title: 'Dentist (moved)' });

    expect((await e.json('DELETE', `/api/calendar/events/${id}`)).status).toBe(400);
    expect((await e.json('DELETE', `/api/calendar/events/${id}`, { confirm: true })).status).toBe(
      204,
    );
    expect(e.api.calls.at(-1)!.method).toBe('DELETE');
    expect((await e.json('PATCH', `/api/calendar/events/${id}`, { confirm: true })).status).toBe(
      404,
    );
  });

  it('returns 503 when Google is not configured', async () => {
    const e = makeTestEnv([]);
    expect((await e.json('POST', '/api/calendar/events', { ...timed, confirm: true })).status).toBe(
      503,
    );
  });
});
