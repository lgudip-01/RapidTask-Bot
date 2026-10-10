import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fakeFetch, staticAuth } from '../../test/fake-fetch';
import { loadFixture } from '../../test/helpers';
import { GoogleCalendarClient } from '../google/calendar-client';
import { GoogleCalendarSource } from '../google/calendar-source';
import { buildAuthUrl, GOOGLE_SCOPES } from '../google/oauth';

/**
 * Guards for "Google and Canvas are read-only" and "the removed Google to-do integration is gone". They scan every tracked
 * file, so a write path or a stray reference added anywhere fails the build.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((f) => f && fs.existsSync(path.join(ROOT, f)))
  .filter((f) => !/\.(png|ico|jpg|jpeg|gif|webp|woff2?)$/i.test(f));
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const isSource = (f: string) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !/\.test\.tsx?$/.test(f);

// Built from pieces so this file does not match itself.
const GOOGLE_TASKS_PATTERNS = [
  'tasks.' + 'googleapis',
  'google' + '_tasks',
  'Google' + 'Tasks',
  'tasks' + ' scope',
];
/** Decision log and audit reports may say that the integration was removed. */
const HISTORY_DOCS = new Set([
  'docs/DECISIONS.md',
  'docs/AUDIT.md',
  'docs/REVIEW.md',
  'docs/COMPLETION-REPORT.md',
]);

describe('the removed Google to-do integration', () => {
  it.each(GOOGLE_TASKS_PATTERNS)('no tracked file contains %j', (needle) => {
    expect(tracked.filter((f) => read(f).includes(needle))).toEqual([]);
  });

  it('no tracked file outside the decision log mentions the integration', () => {
    const phrase = new RegExp('Google' + ' Tasks', 'i');
    expect(tracked.filter((f) => !HISTORY_DOCS.has(f) && phrase.test(read(f)))).toEqual([]);
  });
});

describe('Google Calendar is read-only', () => {
  it('requests exactly the calendar.readonly scope', () => {
    expect(GOOGLE_SCOPES).toEqual(['https://www.googleapis.com/auth/calendar.readonly']);
    const url = new URL(
      buildAuthUrl({
        clientId: 'c',
        redirectUri: 'http://127.0.0.1:1',
        state: 's',
        codeChallenge: 'x',
      }),
    );
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.readonly');
  });

  it('only the calendar client talks to the Calendar API', () => {
    const users = tracked.filter(
      (f) => isSource(f) && read(f).includes('www.googleapis.com/calendar'),
    );
    expect(users).toEqual(['apps/server/src/google/calendar-client.ts']);
  });

  it('the calendar client source has one fetch call, and it is a GET', () => {
    const src = read('apps/server/src/google/calendar-client.ts');
    expect(src.match(/fetchFn\(/g)).toHaveLength(1);
    expect([...src.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1])).toEqual(['GET']);
    expect(src).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
  });

  it('the calendar client exposes no write methods', () => {
    const names = Object.getOwnPropertyNames(GoogleCalendarClient.prototype).sort();
    expect(names).toEqual(['constructor', 'get', 'listEvents']);
  });

  it('a full sync, an incremental sync, and a 410 re-sync send only GET requests', async () => {
    const page1 = loadFixture('google/list-full-page1.json');
    const page2 = loadFixture('google/list-full-page2.json');
    const incremental = loadFixture('google/list-incremental.json');
    let expired = false;
    const api = fakeFetch((req) => {
      const q = req.url.searchParams;
      if (q.get('syncToken') === 'SYNC-1')
        return expired
          ? {
              status: 410,
              json: { error: { code: 410, errors: [{ reason: 'fullSyncRequired' }] } },
            }
          : { status: 200, json: incremental };
      if (q.get('pageToken') === 'PAGE-2') return { status: 200, json: page2 };
      return { status: 200, json: page1 };
    });
    const src = new GoogleCalendarSource(new GoogleCalendarClient(staticAuth(), api), {
      calendarIds: ['primary'],
      appTimeZone: 'America/New_York',
      intervalMs: 600_000,
      lookbackDays: 30,
      now: () => new Date('2026-10-09T16:00:00Z'),
    });
    const full = await src.fetchSince(null);
    await src.fetchSince(full.nextCursor);
    expired = true;
    const resync = await src.fetchSince(full.nextCursor);
    expect(resync.fullResync).toBe(true);

    expect(api.calls.length).toBeGreaterThanOrEqual(5);
    expect(new Set(api.calls.map((c) => c.method))).toEqual(new Set(['GET']));
    expect(new Set(api.calls.map((c) => c.url.host))).toEqual(new Set(['www.googleapis.com']));
  });
});

describe('Canvas is read-only', () => {
  const canvasFiles = tracked.filter(
    (f) =>
      isSource(f) &&
      (f.startsWith('packages/canvas/src/') ||
        f.startsWith('packages/mcp-canvas/src/') ||
        f.startsWith('apps/server/src/canvas/')),
  );

  it('finds the Canvas code to check', () => {
    expect(canvasFiles).toContain('packages/canvas/src/client.ts');
    expect(canvasFiles.length).toBeGreaterThan(3);
  });

  it('no Canvas code sets an HTTP method (fetch defaults to GET)', () => {
    const offenders = canvasFiles.filter((f) =>
      /method\s*:|\b(POST|PUT|PATCH|DELETE)\b/.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });
});
