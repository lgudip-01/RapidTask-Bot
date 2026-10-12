import { describe, expect, it } from 'vitest';
import { fakeFetch, staticAuth, type RecordedRequest } from '../../test/fake-fetch';
import { loadFixture, makeTestEnv } from '../../test/helpers';
import { calendarEvents } from '../db/schema';
import { GoogleCalendarClient } from './calendar-client';
import { GoogleCalendarSource } from './calendar-source';

const page1 = loadFixture('google/list-full-page1.json');
const page2 = loadFixture('google/list-full-page2.json');
const incremental = loadFixture('google/list-incremental.json');

/** Simulates the Calendar API: token-less listing pages, then incremental results. */
function calendarApi(opts: { expiredTokens?: Set<string> } = {}) {
  return fakeFetch((req: RecordedRequest) => {
    const q = req.url.searchParams;
    const syncToken = q.get('syncToken');
    if (syncToken && opts.expiredTokens?.has(syncToken)) {
      return {
        status: 410,
        json: { error: { code: 410, errors: [{ reason: 'fullSyncRequired' }] } },
      };
    }
    if (syncToken === 'SYNC-1') return { status: 200, json: incremental };
    if (q.get('pageToken') === 'PAGE-2') return { status: 200, json: page2 };
    return { status: 200, json: page1 };
  });
}

function source(fetchFn: ReturnType<typeof fakeFetch>, auth = staticAuth()) {
  return new GoogleCalendarSource(new GoogleCalendarClient(auth, fetchFn), {
    calendarIds: ['primary'],
    appTimeZone: 'America/New_York',
    intervalMs: 600_000,
    lookbackDays: 30,
    now: () => new Date('2026-10-09T16:00:00Z'),
  });
}

describe('GoogleCalendarSource', () => {
  it('full sync pages through results, skips noise, and stores the sync token', async () => {
    const api = calendarApi();
    const batch = await source(api).fetchSince(null);

    expect(api.calls).toHaveLength(2);
    const first = api.calls[0]!.url.searchParams;
    expect(first.get('singleEvents')).toBe('true');
    expect(first.get('timeMin')).toBe('2026-09-09T16:00:00.000Z');
    expect(first.get('syncToken')).toBeNull();
    expect(api.calls[0]!.headers.authorization).toBe('Bearer test-access-token');
    expect(api.calls[1]!.url.searchParams.get('pageToken')).toBe('PAGE-2');

    expect(batch.fullResync).toBe(true);
    expect(JSON.parse(batch.nextCursor!)).toEqual({ primary: 'SYNC-1' });
    // 3 + 2 events; the cancelled entry and the working-location entry are dropped.
    expect(batch.items.map((i) => (i.kind === 'event' ? i.data.externalId : i.kind))).toEqual([
      'primary/standup1',
      'primary/allday1',
      'primary/phys201_20261012T130000Z',
      'primary/phys201_20261014T130000Z',
      'primary/london1',
    ]);
  });

  it('incremental sync sends only the sync token and returns updates and deletes', async () => {
    const api = calendarApi();
    const batch = await source(api).fetchSince(JSON.stringify({ primary: 'SYNC-1' }));

    const q = api.calls[0]!.url.searchParams;
    expect(q.get('syncToken')).toBe('SYNC-1');
    expect(q.get('timeMin')).toBeNull();
    expect(batch.fullResync).toBe(false);
    expect(JSON.parse(batch.nextCursor!)).toEqual({ primary: 'SYNC-2' });
    expect(batch.items).toHaveLength(2);
    expect(batch.items[1]).toEqual({
      kind: 'delete',
      entity: 'event',
      source: 'google_calendar',
      externalId: 'primary/phys201_20261014T130000Z',
    });
  });

  it('falls back to a full re-sync on 410 Gone', async () => {
    const api = calendarApi({ expiredTokens: new Set(['STALE']) });
    const batch = await source(api).fetchSince(JSON.stringify({ primary: 'STALE' }));
    expect(api.calls.map((c) => c.url.searchParams.get('syncToken'))).toEqual([
      'STALE',
      null,
      null,
    ]);
    expect(batch.fullResync).toBe(true);
    expect(JSON.parse(batch.nextCursor!)).toEqual({ primary: 'SYNC-1' });
  });

  it('refreshes the access token once on 401', async () => {
    let n = 0;
    const api = fakeFetch(() =>
      n++ === 0 ? { status: 401, json: {} } : { status: 200, json: page2 },
    );
    const auth = staticAuth();
    await source(api, auth).fetchSince(null);
    expect(auth.invalidations).toBe(1);
    expect(api.calls).toHaveLength(2);
  });

  it('surfaces other API errors without leaking request details', async () => {
    const api = fakeFetch(() => ({
      status: 403,
      json: {
        error: {
          code: 403,
          message: 'Rate Limit Exceeded',
          errors: [{ reason: 'rateLimitExceeded' }],
        },
      },
    }));
    await expect(source(api).fetchSince(null)).rejects.toThrow(
      /^Google Calendar GET 403 rateLimitExceeded$/,
    );
  });

  it('end to end through the scheduler: full then incremental', async () => {
    const api = calendarApi();
    const env = await makeTestEnv([source(api)]);

    expect(await env.scheduler.run('google_calendar')).toMatchObject({ ok: true, upserted: 5 });
    expect(await env.scheduler.run('google_calendar')).toMatchObject({
      ok: true,
      upserted: 1,
      deleted: 1,
    });

    const rows = await env.db.select().from(calendarEvents).all();
    expect(rows.map((r) => r.externalId).sort()).toEqual([
      'primary/allday1',
      'primary/london1',
      'primary/phys201_20261012T130000Z',
      'primary/standup1',
    ]);
    const standup = rows.find((r) => r.externalId === 'primary/standup1')!;
    expect(standup.title).toBe('Standup (moved)');
    expect(standup.start.toISOString()).toBe('2026-10-09T14:00:00.000Z');
  });
});
