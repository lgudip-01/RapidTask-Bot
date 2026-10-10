import { DEFAULT_SETTINGS, type Settings } from '@planner/shared';
import { describe, expect, it } from 'vitest';
import { makeTestEnv } from '../../test/helpers';
import type { BackupStatus } from '../backup/backup';
import { calendarEvents, notifications, syncState, tasks } from '../db/schema';
import { Notifier, type NotifierOptions } from './notifier';

const TZ = 'America/New_York';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Fake clock + in-memory database + captured messages. */
function setup(
  startIso: string,
  over: Omit<Partial<NotifierOptions>, 'settings'> & { settings?: Partial<Settings> } = {},
) {
  const env = makeTestEnv([], startIso);
  const sent: string[] = [];
  const { settings: overrides, ...options } = over;
  const settings: Settings = { ...DEFAULT_SETTINGS, ...overrides };
  const make = () =>
    new Notifier(env.db, {
      timeZone: TZ,
      settings: () => settings,
      send: async (text) => void sent.push(text),
      now: env.now,
      ...options,
    });
  let notifier = make();
  return {
    env,
    sent,
    settings,
    tick: () => notifier.tick(),
    /** Moves the clock to `iso` and ticks. */
    at: async (iso: string) => {
      env.advance(Date.parse(iso) - env.now().getTime());
      await notifier.tick();
    },
    restart: () => (notifier = make()),
  };
}

const t0 = new Date('2026-10-09T16:00:00Z');
function addTask(
  env: ReturnType<typeof makeTestEnv>,
  p: {
    id: string;
    title: string;
    due: string;
    source?: 'local' | 'canvas';
    status?: 'todo' | 'done';
    allDay?: boolean;
    course?: string;
  },
) {
  env.db
    .insert(tasks)
    .values({
      id: p.id,
      source: p.source ?? 'local',
      externalId: p.id,
      title: p.title,
      due: new Date(p.due),
      dueAllDay: p.allDay ?? false,
      status: p.status ?? 'todo',
      courseOrProject: p.course ?? null,
      createdAt: t0,
      updatedAt: t0,
      syncedAt: t0,
    })
    .run();
}
function addEvent(
  env: ReturnType<typeof makeTestEnv>,
  p: {
    id: string;
    title: string;
    start: string;
    end: string;
    source?: 'local' | 'google_calendar';
    allDay?: boolean;
    location?: string;
  },
) {
  env.db
    .insert(calendarEvents)
    .values({
      id: p.id,
      source: p.source ?? 'local',
      externalId: p.id,
      title: p.title,
      start: new Date(p.start),
      end: new Date(p.end),
      allDay: p.allDay ?? false,
      location: p.location ?? null,
      updatedAt: t0,
      syncedAt: t0,
    })
    .run();
}

describe('daily digest', () => {
  it('fires at 07:30 New York exactly once a day, and not again after a restart', async () => {
    const n = setup('2026-10-12T11:00:00Z'); // Mon 07:00 EDT
    addEvent(n.env, {
      id: 'e1',
      title: 'PHYS 201 Lecture',
      start: '2026-10-12T14:00:00Z',
      end: '2026-10-12T15:15:00Z',
    });
    addTask(n.env, { id: 't1', title: 'Pay rent', due: '2026-10-12T04:00:00Z', allDay: true });

    await n.tick();
    await n.at('2026-10-12T11:29:59Z');
    expect(n.sent).toEqual([]);
    await n.at('2026-10-12T11:30:00Z');
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]).toMatch(/^☀️ Good morning!\nToday, Mon, Oct 12/);
    expect(n.sent[0]).toContain('10:00 AM PHYS 201 Lecture');
    expect(n.sent[0]).toContain('1. Pay rent');

    await n.at('2026-10-12T11:31:00Z');
    n.restart();
    await n.at('2026-10-12T12:00:00Z');
    expect(n.sent).toHaveLength(1);

    await n.at('2026-10-13T11:30:00Z');
    expect(n.sent).toHaveLength(2);
    expect(n.sent[1]).toContain('Today, Tue, Oct 13');
  });

  it('follows the DST change: 11:30Z on Sat Oct 31 (EDT), 12:30Z on Sun Nov 1 (EST)', async () => {
    const n = setup('2026-10-31T11:00:00Z');
    await n.at('2026-10-31T11:30:00Z');
    expect(n.sent).toHaveLength(1);
    await n.at('2026-11-01T11:30:00Z'); // 06:30 EST: too early
    expect(n.sent).toHaveLength(1);
    await n.at('2026-11-01T12:29:00Z');
    expect(n.sent).toHaveLength(1);
    await n.at('2026-11-01T12:30:00Z');
    expect(n.sent).toHaveLength(2);
    expect(n.sent[1]).toContain('Today, Sun, Nov 1');
  });

  it('is sent late after downtime within 3 hours, otherwise skipped for that day', async () => {
    const late = setup('2026-10-12T13:00:00Z'); // 09:00 EDT
    await late.tick();
    expect(late.sent).toHaveLength(1);
    const tooLate = setup('2026-10-12T14:31:00Z'); // 10:31 EDT
    await tooLate.tick();
    expect(tooLate.sent).toEqual([]);
  });

  it('respects the setting and a custom time', async () => {
    const off = setup('2026-10-12T11:30:00Z', { settings: { digestEnabled: false } });
    await off.tick();
    expect(off.sent).toEqual([]);
    const custom = setup('2026-10-12T11:30:00Z', { settings: { digestTime: '06:15' } });
    await custom.tick(); // 07:30 EDT is 75 min after 06:15: within the grace window
    expect(custom.sent).toHaveLength(1);
  });
});

describe('deadline reminders', () => {
  it('the evening before at 19:00, once, listing open Canvas and Planner tasks due tomorrow', async () => {
    const n = setup('2026-10-12T22:00:00Z', { settings: { digestEnabled: false } }); // Mon 18:00 EDT
    addTask(n.env, {
      id: 'c1',
      title: 'HW 6',
      due: '2026-10-14T03:59:00Z',
      source: 'canvas',
      course: 'MATH 221',
    }); // Tue 23:59
    addTask(n.env, {
      id: 'l1',
      title: 'Return library books',
      due: '2026-10-13T04:00:00Z',
      allDay: true,
    }); // Tue
    addTask(n.env, {
      id: 'd1',
      title: 'Already done',
      due: '2026-10-13T15:00:00Z',
      status: 'done',
    });
    addTask(n.env, { id: 'w1', title: 'Wednesday thing', due: '2026-10-14T15:00:00Z' });

    await n.at('2026-10-12T22:59:00Z');
    expect(n.sent).toEqual([]);
    await n.at('2026-10-12T23:00:00Z');
    expect(n.sent).toEqual([
      '📌 Due tomorrow, Tue, Oct 13:\n• Return library books\n• HW 6 — 11:59 PM (Canvas: MATH 221)',
    ]);
    await n.at('2026-10-13T01:00:00Z');
    expect(n.sent).toHaveLength(1);
  });

  it('can be turned off', async () => {
    const n = setup('2026-10-12T23:00:00Z', {
      settings: { deadlineReminders: false, digestEnabled: false },
    });
    addTask(n.env, { id: 'c1', title: 'HW 6', due: '2026-10-13T15:00:00Z', source: 'canvas' });
    await n.tick();
    expect(n.sent).toEqual([]);
  });
});

describe('event reminders', () => {
  it('one hour before each timed event (any source), once; never for all-day events', async () => {
    const n = setup('2026-10-12T17:00:00Z', {
      settings: { digestEnabled: false, deadlineReminders: false },
    });
    addEvent(n.env, {
      id: 'e1',
      title: 'Dentist',
      start: '2026-10-12T19:00:00Z',
      end: '2026-10-12T20:00:00Z',
      location: 'Main St',
    });
    addEvent(n.env, {
      id: 'g1',
      title: 'Team sync',
      start: '2026-10-12T19:30:00Z',
      end: '2026-10-12T20:00:00Z',
      source: 'google_calendar',
    });
    addEvent(n.env, {
      id: 'a1',
      title: 'Holiday',
      start: '2026-10-12T04:00:00Z',
      end: '2026-10-13T04:00:00Z',
      allDay: true,
    });

    await n.at('2026-10-12T17:59:00Z');
    expect(n.sent).toEqual([]);
    await n.at('2026-10-12T18:00:00Z');
    expect(n.sent).toEqual(['⏰ Coming up:\n• 3:00 PM Dentist @ Main St (in 60 min)']);
    await n.at('2026-10-12T18:30:00Z');
    expect(n.sent[1]).toBe('⏰ Coming up:\n• 3:30 PM Team sync (in 60 min)');
    await n.at('2026-10-12T18:45:00Z');
    await n.at('2026-10-12T19:10:00Z');
    expect(n.sent).toHaveLength(2);
  });

  it('uses the configured lead time', async () => {
    const n = setup('2026-10-12T18:00:00Z', {
      settings: { digestEnabled: false, deadlineReminders: false, eventReminderMinutes: 15 },
    });
    addEvent(n.env, {
      id: 'e1',
      title: 'Dentist',
      start: '2026-10-12T19:00:00Z',
      end: '2026-10-12T20:00:00Z',
    });
    await n.tick();
    expect(n.sent).toEqual([]);
    await n.at('2026-10-12T18:45:00Z');
    expect(n.sent).toEqual(['⏰ Coming up:\n• 3:00 PM Dentist (in 15 min)']);
  });
});

describe('health alerts', () => {
  const quiet = { digestEnabled: false, deadlineReminders: false, eventReminders: false };
  const failing = (env: ReturnType<typeof makeTestEnv>, source: string, error: string, n: number) =>
    env.db
      .insert(syncState)
      .values({ source, lastError: error, consecutiveFailures: n })
      .onConflictDoUpdate({
        target: syncState.source,
        set: { lastError: error, consecutiveFailures: n },
      })
      .run();

  it('Google access revoked: one specific alert per day (not also a generic sync alert)', async () => {
    const n = setup('2026-10-12T16:00:00Z', { settings: quiet });
    failing(
      n.env,
      'google_calendar',
      'GoogleAuthError: Google refresh token was rejected (expired or revoked): run `npm run auth:google`',
      5,
    );
    await n.tick();
    await n.at('2026-10-12T20:00:00Z');
    expect(n.sent).toEqual([expect.stringMatching(/^⚠️ Google Calendar access was revoked/)]);
    await n.at('2026-10-13T16:00:00Z');
    expect(n.sent).toHaveLength(2);
  });

  it('Canvas token rejected (401/403)', async () => {
    const n = setup('2026-10-12T16:00:00Z', { settings: quiet });
    failing(n.env, 'canvas', 'CanvasApiError: Canvas GET /api/v1/courses 401', 1);
    await n.tick();
    expect(n.sent).toEqual([
      expect.stringContaining('Canvas is refusing Planner’s requests (HTTP 401/403)'),
    ]);
  });

  it('repeated sync failures alert at the threshold', async () => {
    const n = setup('2026-10-12T16:00:00Z', { settings: quiet });
    failing(n.env, 'canvas', 'Canvas GET /api/v1/courses 500', 2);
    await n.tick();
    expect(n.sent).toEqual([]);
    failing(n.env, 'canvas', 'Canvas GET /api/v1/courses 500', 3);
    await n.at('2026-10-12T16:01:00Z');
    expect(n.sent).toEqual([
      '⚠️ Canvas sync has failed 3 times in a row. Last error: Canvas GET /api/v1/courses 500',
    ]);
    failing(n.env, 'canvas', 'Canvas GET /api/v1/courses 500', 9);
    await n.at('2026-10-12T22:00:00Z');
    expect(n.sent).toHaveLength(1);
  });

  it('Canvas token expiry: warns within 7 days, daily', async () => {
    const n = setup('2026-10-12T16:00:00Z', {
      settings: quiet,
      canvasTokenExpiresAt: new Date('2026-10-20T04:00:00Z'),
    });
    await n.tick(); // 8 days left
    expect(n.sent).toEqual([]);
    await n.at('2026-10-14T16:00:00Z');
    expect(n.sent).toEqual([
      expect.stringMatching(/^⏳ Your Canvas access token expires Tue, Oct 20 \(in 6 days\)/),
    ]);
    await n.at('2026-10-14T20:00:00Z');
    await n.at('2026-10-21T16:00:00Z');
    expect(n.sent).toHaveLength(2);
    expect(n.sent[1]).toMatch(/expired on Tue, Oct 20/);
  });

  it('backup failed or older than 48 hours: once per day each', async () => {
    let status: Partial<BackupStatus> = { health: 'ok', lastSuccessAt: '2026-10-12T07:00:00.000Z' };
    const n = setup('2026-10-12T16:00:00Z', {
      settings: quiet,
      backupStatus: () => status as BackupStatus,
    });
    await n.tick();
    expect(n.sent).toEqual([]);
    status = {
      health: 'failed',
      lastError: 'ENOSPC: no space left',
      lastSuccessAt: '2026-10-12T07:00:00.000Z',
    };
    await n.at('2026-10-13T08:00:00Z');
    await n.at('2026-10-13T09:00:00Z');
    expect(n.sent).toEqual([
      '⚠️ Planner backup failed (ENOSPC: no space left). Last good backup: 25 hours ago. Open Settings → Backups.',
    ]);
    status = { health: 'stale', lastSuccessAt: '2026-10-12T07:00:00.000Z' };
    await n.at('2026-10-14T08:00:00Z');
    expect(n.sent[1]).toBe(
      '⚠️ Planner backups are stale. Last good backup: 49 hours ago. Open Settings → Backups.',
    );
  });
});

describe('delivery', () => {
  it('a failed send is retried on the next tick and still delivered only once', async () => {
    const env = makeTestEnv([], '2026-10-12T11:30:00Z');
    const sent: string[] = [];
    let fail = true;
    const n = new Notifier(env.db, {
      timeZone: TZ,
      settings: () => DEFAULT_SETTINGS,
      send: async (text) => {
        if (fail) throw new Error('telegram 502');
        sent.push(text);
      },
      now: env.now,
    });
    await n.tick();
    expect(sent).toEqual([]);
    expect(env.db.select().from(notifications).all()).toEqual([]);
    fail = false;
    env.advance(MIN);
    await n.tick();
    env.advance(MIN);
    await n.tick();
    expect(sent).toHaveLength(1);
    expect(env.db.select().from(notifications).all()).toEqual([
      expect.objectContaining({ kind: 'digest', key: '2026-10-12' }),
    ]);
  });

  it('forgets claims after 90 days', async () => {
    const n = setup('2026-10-12T11:30:00Z');
    await n.tick();
    expect(n.env.db.select().from(notifications).all()).toHaveLength(1);
    n.env.advance(91 * DAY + HOUR); // 07:30 EST is 12:30Z in January
    await n.tick();
    expect(
      n.env.db
        .select()
        .from(notifications)
        .all()
        .map((r) => r.key),
    ).toEqual(['2027-01-11']);
  });
});
