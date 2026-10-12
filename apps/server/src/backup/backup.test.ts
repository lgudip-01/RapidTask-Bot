import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../db/client';
import { backupRuns, tasks } from '../db/schema';
import { BackupService, exportData, verifySnapshot } from './backup';
import { importData } from './import';
import { restoreSnapshot } from './restore';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'planner-backup-'));
const HOUR = 3_600_000;

async function setup(opts: { keep?: number; failDir?: boolean } = {}) {
  const dir = tmp();
  const dbPath = path.join(dir, 'planner.db');
  const db = await createDb(dbPath);
  let t = Date.parse('2026-10-09T16:00:00Z');
  const timers: { fn: () => void; ms: number }[] = [];
  const backupDir = opts.failDir ? path.join(dir, 'not-a-dir.txt') : path.join(dir, 'backups');
  if (opts.failDir) fs.writeFileSync(backupDir, 'x'); // a file where the directory should be
  const service = new BackupService(db, {
    target: { kind: 'file', dir: backupDir, keep: opts.keep ?? 14 },
    hour: 3,
    timeZone: 'America/New_York',
    enabled: true,
    now: () => new Date(t),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
  });
  const addTask = (title: string) =>
    db
      .insert(tasks)
      .values({
        id: title,
        source: 'local',
        externalId: title,
        title,
        dueAllDay: true,
        createdAt: new Date(t),
        updatedAt: new Date(t),
        syncedAt: new Date(t),
      })
      .run();
  return {
    dir,
    dbPath,
    db,
    service,
    backupDir,
    timers,
    addTask,
    advance: (ms: number) => (t += ms),
  };
}

describe('BackupService', () => {
  it('writes a verified snapshot and JSON export, and records the run', async () => {
    const s = await setup();
    await s.addTask('Pay rent');
    const run = await s.service.runNow('manual');
    expect(run).toMatchObject({ ok: true, reason: 'manual', taskCount: 1, error: null });
    expect(run.file).toMatch(/^planner-20261009-160000\.db$/);
    expect(await verifySnapshot(path.join(s.backupDir, run.file!))).toEqual({
      tasks: 1,
      events: 0,
    });
    const json = JSON.parse(
      fs.readFileSync(path.join(s.backupDir, run.file!.replace('.db', '.json')), 'utf8'),
    );
    expect(json).toMatchObject({ version: 2, count: 1 });
    expect(await s.service.status()).toMatchObject({
      health: 'ok',
      lastFile: run.file,
      running: false,
    });
  });

  it('keeps only the newest N snapshots', async () => {
    const s = await setup({ keep: 2 });
    for (let i = 0; i < 4; i++) {
      await s.service.runNow('manual');
      s.advance(HOUR);
    }
    const files = fs.readdirSync(s.backupDir).sort();
    expect(files).toEqual([
      'planner-20261009-180000.db',
      'planner-20261009-180000.json',
      'planner-20261009-190000.db',
      'planner-20261009-190000.json',
    ]);
  });

  // Alerting on these states is the Notifier's job (notify/notifier.test.ts).
  it('records failures and reports health "failed" until a good run', async () => {
    const s = await setup({ failDir: true });
    const run = await s.service.runNow('manual');
    expect(run.ok).toBe(false);
    expect(run.error).toMatch(/EEXIST|ENOTDIR|exists/i);
    expect(await s.service.status()).toMatchObject({ health: 'failed', lastError: run.error });
  });

  it('reports "stale" once the newest good backup is older than 48 hours', async () => {
    const s = await setup();
    await s.service.runNow('manual');
    s.advance(47 * HOUR);
    expect((await s.service.status()).health).toBe('ok');
    s.advance(2 * HOUR);
    expect(await s.service.status()).toMatchObject({
      health: 'stale',
      lastSuccessAt: '2026-10-09T16:00:00.000Z',
    });
  });

  it('reports "never" (not stale) right after first start, and catches up immediately', async () => {
    const s = await setup();
    expect((await s.service.status()).health).toBe('never');
    await s.service.start();
    expect(await s.db.select().from(backupRuns).all()).toEqual([
      expect.objectContaining({ reason: 'catch-up', ok: true }),
    ]);
    // Nightly at 03:00 New York = 07:00 UTC tomorrow (now is 12:00 EDT).
    expect((await s.service.status()).nextScheduledAt).toBe('2026-10-10T07:00:00.000Z');
    // Only the nightly timer: health is checked by the Notifier every minute.
    expect(s.timers.map((x) => x.ms)).toEqual([15 * HOUR]);
  });
});

describe('restore', () => {
  it('round-trips: back up, change data, restore, and keep the replaced database', async () => {
    const s = await setup();
    await s.addTask('Keep me');
    const run = await s.service.runNow('manual');
    await s.db.delete(tasks).where(eq(tasks.id, 'Keep me')).run();
    await s.addTask('Added after backup');
    // The restore CLI runs with the server stopped, in its own process. Here the live database is
    // still open in this process, so restore onto a stand-in for it.
    const live = path.join(s.dir, 'live.db');
    fs.writeFileSync(live, 'the database being replaced');

    const r = await restoreSnapshot({
      snapshot: path.join(s.backupDir, run.file!),
      dbPath: live,
      now: new Date('2026-10-10T12:00:00Z'),
    });
    expect(r).toMatchObject({ tasks: 1, events: 0 });
    expect(r.previous).toBe(`${live}.pre-restore-20261010T120000`);
    expect(fs.readFileSync(r.previous!, 'utf8')).toBe('the database being replaced');

    const restored = await createDb(live);
    expect((await restored.select().from(tasks).all()).map((x) => x.title)).toEqual(['Keep me']);
    restored.$client.close();
  });

  it('refuses a corrupt or missing snapshot and leaves the database untouched', async () => {
    const s = await setup();
    await s.addTask('Precious');
    const bad = path.join(s.dir, 'bad.db');
    fs.writeFileSync(bad, 'not a database');
    await expect(restoreSnapshot({ snapshot: bad, dbPath: s.dbPath })).rejects.toThrow();
    await expect(
      restoreSnapshot({ snapshot: path.join(s.dir, 'nope.db'), dbPath: s.dbPath }),
    ).rejects.toThrow();
    expect((await s.db.select().from(tasks).all()).map((x) => x.title)).toEqual(['Precious']);
  });
});

describe('serverless backups', () => {
  async function telegramSetup(opts: { failSend?: boolean } = {}) {
    const db = await createDb(':memory:');
    let t = Date.parse('2026-10-09T16:00:00Z'); // Fri 12:00 New York
    const sent: { fileName: string; content: string; caption: string }[] = [];
    const service = new BackupService(db, {
      target: {
        kind: 'telegram',
        send: async (fileName, content, caption) => {
          if (opts.failSend) throw new Error('Telegram sendDocument 502: Bad Gateway');
          sent.push({ fileName, content, caption });
        },
      },
      hour: 3,
      timeZone: 'America/New_York',
      enabled: true,
      now: () => new Date(t),
    });
    await db
      .insert(tasks)
      .values({
        id: 'rent',
        source: 'local',
        externalId: 'rent',
        title: 'Pay rent',
        dueAllDay: true,
        createdAt: new Date(t),
        updatedAt: new Date(t),
        syncedAt: new Date(t),
      })
      .run();
    return { db, service, sent, at: (iso: string) => (t = Date.parse(iso)) };
  }

  it('sends the JSON export to the owner as a Telegram file and records the run', async () => {
    const s = await telegramSetup();
    const run = await s.service.runNow('manual');
    expect(run).toMatchObject({ ok: true, file: 'planner-20261009-160000.json', taskCount: 1 });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.caption).toBe('🗄️ Planner backup: 1 tasks, 0 Planner events.');
    expect(JSON.parse(s.sent[0]!.content)).toMatchObject({ version: 2, count: 1 });
    expect(await s.service.status()).toMatchObject({ health: 'ok', target: 'telegram' });
  });

  it('runIfDue: once per nightly slot, retrying a failure only after an hour', async () => {
    const s = await telegramSetup();
    // 12:00 Fri: the 03:00 Fri slot has passed with no backup → runs.
    expect(await s.service.runIfDue()).toMatchObject({ ok: true, reason: 'scheduled' });
    s.at('2026-10-09T16:05:00Z');
    expect(await s.service.runIfDue()).toBeNull();
    // Next slot: Sat 03:00 New York = 07:00 UTC.
    s.at('2026-10-10T06:55:00Z');
    expect(await s.service.runIfDue()).toBeNull();
    s.at('2026-10-10T07:05:00Z');
    expect(await s.service.runIfDue()).toMatchObject({ ok: true });
    expect(s.sent).toHaveLength(2);
  });

  it('runIfDue: waits an hour after a failed attempt', async () => {
    const s = await telegramSetup({ failSend: true });
    expect(await s.service.runIfDue()).toMatchObject({ ok: false });
    expect((await s.service.status()).health).toBe('failed');
    s.at('2026-10-09T16:30:00Z');
    expect(await s.service.runIfDue()).toBeNull();
    s.at('2026-10-09T17:01:00Z');
    expect(await s.service.runIfDue()).toMatchObject({ ok: false });
  });
});

describe('restore from a JSON export', () => {
  it('imports tasks and Planner events into an empty database, and is safe to repeat', async () => {
    const s = await setup();
    await s.addTask('Pay rent');
    const exported = JSON.parse(JSON.stringify(await exportData(s.db)));

    const fresh = await createDb(':memory:');
    expect(await importData(fresh, exported)).toEqual({ tasks: 1, events: 0, skipped: 0 });
    expect((await fresh.select().from(tasks).all()).map((t) => t.title)).toEqual(['Pay rent']);
    expect(await importData(fresh, exported)).toEqual({ tasks: 0, events: 0, skipped: 1 });
  });

  it('rejects a file that is not a Planner export', async () => {
    const fresh = await createDb(':memory:');
    await expect(importData(fresh, { hello: 'world' })).rejects.toThrow();
  });
});
