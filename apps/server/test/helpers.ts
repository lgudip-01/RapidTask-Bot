import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type AppDeps } from '../src/app';
import { createDb, type Db } from '../src/db/client';
import { FakeSource, type FixturePage } from '../src/sync/fake-source';
import { SettingsStore } from '../src/settings';
import { SyncScheduler } from '../src/sync/scheduler';
import type { SyncSource } from '../src/sync/types';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function loadFixture<T = unknown>(rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, rel), 'utf8')) as T;
}

export function fakeSource(pagesFixture: string, name = 'fake') {
  return new FakeSource(name, loadFixture<FixturePage[]>(pagesFixture), {
    event: ['google_calendar'],
    task: ['canvas', 'google_tasks'],
  });
}

/** Manual clock + timer capture so scheduler tests are deterministic. */
export function makeTestEnv(
  sources: SyncSource[],
  startAt = '2026-10-09T16:00:00.000Z',
  extra:
    | Partial<Pick<AppDeps, 'calendar' | 'inbound' | 'capture'>>
    | ((
        db: Db,
        now: () => Date,
      ) => Partial<Pick<AppDeps, 'calendar' | 'inbound' | 'capture'>>) = {},
) {
  let nowMs = Date.parse(startAt);
  const timers: { fn: () => void; ms: number }[] = [];
  const db = createDb(':memory:');
  const now = () => new Date(nowMs);
  const scheduler = new SyncScheduler(db, sources, {
    now,
    random: () => 0,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
  });
  const app = createApp({
    db,
    scheduler,
    now,
    timeZone: 'America/New_York',
    settings: new SettingsStore(db, now),
    ...(typeof extra === 'function' ? extra(db, now) : extra),
  });
  return {
    db,
    scheduler,
    app,
    timers,
    now,
    advance: (ms: number) => (nowMs += ms),
    json: async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
  };
}
