import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../db/client';
import { backupRuns, tasks } from '../db/schema';
import { BackupService, verifySnapshot } from './backup';
import { restoreSnapshot } from './restore';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'planner-backup-'));
const HOUR = 3_600_000;

function setup(opts: { keep?: number; failDir?: boolean } = {}) {
  const dir = tmp();
  const dbPath = path.join(dir, 'planner.db');
  const db = createDb(dbPath);
  let t = Date.parse('2026-10-09T16:00:00Z');
  const timers: { fn: () => void; ms: number }[] = [];
  const backupDir = opts.failDir ? path.join(dir, 'not-a-dir.txt') : path.join(dir, 'backups');
  if (opts.failDir) fs.writeFileSync(backupDir, 'x'); // a file where the directory should be
  const service = new BackupService(db, {
    dir: backupDir,
    keep: opts.keep ?? 14,
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
    const s = setup();
    s.addTask('Pay rent');
    const run = await s.service.runNow('manual');
    expect(run).toMatchObject({ ok: true, reason: 'manual', taskCount: 1, error: null });
    expect(run.file).toMatch(/^planner-20261009-160000\.db$/);
    expect(verifySnapshot(path.join(s.backupDir, run.file!))).toEqual({ tasks: 1, events: 0 });
    const json = JSON.parse(
      fs.readFileSync(path.join(s.backupDir, run.file!.replace('.db', '.json')), 'utf8'),
    );
    expect(json).toMatchObject({ version: 2, count: 1 });
    expect(s.service.status()).toMatchObject({ health: 'ok', lastFile: run.file, running: false });
  });

  it('keeps only the newest N snapshots', async () => {
    const s = setup({ keep: 2 });
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
    const s = setup({ failDir: true });
    const run = await s.service.runNow('manual');
    expect(run.ok).toBe(false);
    expect(run.error).toMatch(/EEXIST|ENOTDIR|exists/i);
    expect(s.service.status()).toMatchObject({ health: 'failed', lastError: run.error });
  });

  it('reports "stale" once the newest good backup is older than 48 hours', async () => {
    const s = setup();
    await s.service.runNow('manual');
    s.advance(47 * HOUR);
    expect(s.service.status().health).toBe('ok');
    s.advance(2 * HOUR);
    expect(s.service.status()).toMatchObject({
      health: 'stale',
      lastSuccessAt: '2026-10-09T16:00:00.000Z',
    });
  });

  it('reports "never" (not stale) right after first start, and catches up immediately', async () => {
    const s = setup();
    expect(s.service.status().health).toBe('never');
    await s.service.start();
    expect(s.db.select().from(backupRuns).all()).toEqual([
      expect.objectContaining({ reason: 'catch-up', ok: true }),
    ]);
    // Nightly at 03:00 New York = 07:00 UTC tomorrow (now is 12:00 EDT).
    expect(s.service.status().nextScheduledAt).toBe('2026-10-10T07:00:00.000Z');
    // Only the nightly timer: health is checked by the Notifier every minute.
    expect(s.timers.map((x) => x.ms)).toEqual([15 * HOUR]);
  });
});

describe('restore', () => {
  it('round-trips: back up, change data, restore, and keep the replaced database', async () => {
    const s = setup();
    s.addTask('Keep me');
    const run = await s.service.runNow('manual');
    s.db.delete(tasks).where(eq(tasks.id, 'Keep me')).run();
    s.addTask('Added after backup');
    s.db.$client.close(); // server stopped

    const r = restoreSnapshot({
      snapshot: path.join(s.backupDir, run.file!),
      dbPath: s.dbPath,
      now: new Date('2026-10-10T12:00:00Z'),
    });
    expect(r).toMatchObject({ tasks: 1, events: 0 });
    expect(r.previous).toBe(`${s.dbPath}.pre-restore-20261010T120000`);
    expect(fs.existsSync(r.previous!)).toBe(true);

    const restored = createDb(s.dbPath);
    expect(
      restored
        .select()
        .from(tasks)
        .all()
        .map((x) => x.title),
    ).toEqual(['Keep me']);
    restored.$client.close();
  });

  it('refuses a corrupt or missing snapshot and leaves the database untouched', () => {
    const s = setup();
    s.addTask('Precious');
    const bad = path.join(s.dir, 'bad.db');
    fs.writeFileSync(bad, 'not a database');
    expect(() => restoreSnapshot({ snapshot: bad, dbPath: s.dbPath })).toThrow();
    expect(() =>
      restoreSnapshot({ snapshot: path.join(s.dir, 'nope.db'), dbPath: s.dbPath }),
    ).toThrow();
    expect(
      s.db
        .select()
        .from(tasks)
        .all()
        .map((x) => x.title),
    ).toEqual(['Precious']);
  });
});
