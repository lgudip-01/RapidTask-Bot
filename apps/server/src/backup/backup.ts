import { addDays, dateInZone, zonedTimeToUtc } from '@planner/shared';
import { asc, desc, eq, gte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChangeTopic } from '../changes';
import type { Db } from '../db/client';
import { toEventJson, toTaskJson } from '../db/mappers';
import { backupRuns, calendarEvents, tasks, type BackupRunRow } from '../db/schema';
import { log, sanitizeError } from '../log';

const HOUR = 3_600_000;
export const STALE_AFTER_MS = 48 * HOUR;
/** After a failed attempt, the cron path waits this long before trying again. */
export const RETRY_AFTER_MS = HOUR;
const SNAPSHOT_RE = /^planner-\d{8}-\d{6}\.db$/;

export type BackupHealth = 'ok' | 'never' | 'stale' | 'failed';

export interface BackupStatus {
  health: BackupHealth;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastFile: string | null;
  lastSizeBytes: number | null;
  nextScheduledAt: string | null;
  running: boolean;
  enabled: boolean;
  keep: number;
  /** Where backups go: snapshot files on this machine, or a file sent to the owner on Telegram. */
  target: BackupTarget['kind'];
}

/** Everything the owner created (all tasks + Planner-only events) as portable JSON. */
export async function exportData(db: Db, now = new Date()) {
  const taskRows = await db
    .select()
    .from(tasks)
    .orderBy(asc(tasks.source), asc(tasks.createdAt))
    .all();
  const eventRows = await db
    .select()
    .from(calendarEvents)
    .where(eq(calendarEvents.source, 'local'))
    .orderBy(asc(calendarEvents.start))
    .all();
  return {
    version: 2,
    exportedAt: now.toISOString(),
    count: taskRows.length,
    tasks: taskRows.map(toTaskJson),
    localEvents: eventRows.map(toEventJson),
  };
}

/**
 * Snapshot files are opened with Node's built-in SQLite: it releases the file on close (libsql
 * holds Windows file handles until garbage collection), so snapshots can be pruned and restored.
 * Local backups only; the serverless path never touches files.
 */
async function openSnapshot(file: string, readOnly: boolean) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly });
}

/** Opens a snapshot and checks it is an intact Planner database. */
export async function verifySnapshot(file: string) {
  if (!fs.existsSync(file)) throw new Error(`snapshot not found: ${path.basename(file)}`);
  const db = await openSnapshot(file, true);
  try {
    const check = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
      .integrity_check;
    if (check !== 'ok') throw new Error(`integrity check failed: ${String(check)}`);
    const count = (table: string) =>
      Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
    return { tasks: count('tasks'), events: count('calendar_events') };
  } finally {
    db.close();
  }
}

/** A snapshot copied from a WAL database can carry the WAL flag; make it one self-contained file. */
async function makeStandalone(file: string) {
  const db = await openSnapshot(file, false);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
  } finally {
    db.close();
  }
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

export type BackupTarget =
  /** Local development / a host with a disk: consistent snapshot + JSON export, newest `keep`. */
  | { kind: 'file'; dir: string; keep: number }
  /** Serverless (no disk): the JSON export is sent to the owner as a Telegram document. */
  | {
      kind: 'telegram';
      send: (fileName: string, content: string, caption: string) => Promise<void>;
    };

export interface BackupOptions {
  target: BackupTarget;
  hour: number;
  timeZone: string;
  enabled: boolean;
  now?: () => Date;
  onChange?: (topic: ChangeTopic) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/**
 * Nightly backups, recorded in `backup_runs`. `status()` reports health; the Notifier alerts the
 * owner when a backup failed or the newest good one is older than 48 hours. A long-running server
 * schedules itself (`start`); on serverless the cron endpoint calls `runIfDue`.
 */
export class BackupService {
  private running = false;
  private readonly startedAt: number;
  private readonly timers: unknown[] = [];
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    private readonly o: BackupOptions,
  ) {
    this.now = o.now ?? (() => new Date());
    this.startedAt = this.now().getTime();
  }

  private lastRun(onlyOk = false) {
    const q = this.db.select().from(backupRuns);
    return (onlyOk ? q.where(eq(backupRuns.ok, true)) : q)
      .orderBy(desc(backupRuns.startedAt))
      .get();
  }

  recent(limit = 10): Promise<BackupRunRow[]> {
    return this.db.select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(limit).all();
  }

  private scheduledOn(day: string) {
    const [y, m, d] = day.split('-').map(Number);
    return zonedTimeToUtc(this.o.timeZone, y!, m!, d!, this.o.hour);
  }

  /** Next nightly run: BACKUP_HOUR:00 local time, today if still ahead, else tomorrow. */
  nextScheduledAt(): Date {
    const now = this.now();
    const today = dateInZone(now, this.o.timeZone);
    for (const day of [today, addDays(today, 1)]) {
      const at = this.scheduledOn(day);
      if (at > now) return at;
    }
    throw new Error('unreachable');
  }

  /** The most recent nightly slot that has already passed. */
  private previousScheduledAt(): Date {
    const now = this.now();
    const today = dateInZone(now, this.o.timeZone);
    const at = this.scheduledOn(today);
    return at <= now ? at : this.scheduledOn(addDays(today, -1));
  }

  async status(): Promise<BackupStatus> {
    const last = await this.lastRun();
    const good = await this.lastRun(true);
    const t = this.now().getTime();
    let health: BackupHealth;
    if (last && !last.ok) health = 'failed';
    else if (good) health = t - good.finishedAt!.getTime() > STALE_AFTER_MS ? 'stale' : 'ok';
    else health = t - this.startedAt > STALE_AFTER_MS ? 'stale' : 'never';
    return {
      health,
      lastSuccessAt: good?.finishedAt?.toISOString() ?? null,
      lastAttemptAt: last?.startedAt.toISOString() ?? null,
      lastError: last && !last.ok ? last.error : null,
      lastFile: good?.file ?? null,
      lastSizeBytes: good?.sizeBytes ?? null,
      nextScheduledAt: this.o.enabled ? this.nextScheduledAt().toISOString() : null,
      running: this.running,
      enabled: this.o.enabled,
      keep: this.o.target.kind === 'file' ? this.o.target.keep : 0,
      target: this.o.target.kind,
    };
  }

  isRunning() {
    return this.running;
  }

  async runNow(reason: BackupRunRow['reason']): Promise<BackupRunRow> {
    if (this.running) throw new Error('backup already running');
    this.running = true;
    const id = randomUUID();
    const startedAt = this.now();
    await this.db.insert(backupRuns).values({ id, reason, startedAt }).run();
    try {
      const result =
        this.o.target.kind === 'file'
          ? await this.toFile(this.o.target, startedAt)
          : await this.toTelegram(this.o.target, startedAt);
      const row = (await this.db
        .update(backupRuns)
        .set({ ok: true, finishedAt: this.now(), ...result })
        .where(eq(backupRuns.id, id))
        .returning()
        .get())!;
      log.info('backup ok', { reason, sizeBytes: row.sizeBytes, tasks: result.taskCount });
      return row;
    } catch (e) {
      const error = sanitizeError(e);
      const row = (await this.db
        .update(backupRuns)
        .set({ ok: false, finishedAt: this.now(), error })
        .where(eq(backupRuns.id, id))
        .returning()
        .get())!;
      log.error('backup failed', { reason, error });
      return row;
    } finally {
      this.running = false;
      this.o.onChange?.('backup');
    }
  }

  private async toFile(target: Extract<BackupTarget, { kind: 'file' }>, startedAt: Date) {
    fs.mkdirSync(target.dir, { recursive: true });
    const base = `planner-${stamp(startedAt)}`;
    const file = path.join(target.dir, `${base}.db`);
    // A consistent copy of the live database, taken inside SQLite.
    await this.db.$client.execute({ sql: 'VACUUM INTO ?', args: [path.resolve(file)] });
    await makeStandalone(file);
    const counts = await verifySnapshot(file);
    fs.writeFileSync(
      path.join(target.dir, `${base}.json`),
      JSON.stringify(await exportData(this.db, startedAt), null, 2) + '\n',
      { mode: 0o600 },
    );
    this.prune(target);
    return {
      file: `${base}.db`,
      sizeBytes: fs.statSync(file).size,
      taskCount: counts.tasks,
      eventCount: counts.events,
    };
  }

  private async toTelegram(target: Extract<BackupTarget, { kind: 'telegram' }>, startedAt: Date) {
    const data = await exportData(this.db, startedAt);
    const content = JSON.stringify(data, null, 2) + '\n';
    const file = `planner-${stamp(startedAt)}.json`;
    await target.send(
      file,
      content,
      `🗄️ Planner backup: ${data.count} tasks, ${data.localEvents.length} Planner events.`,
    );
    return {
      file,
      sizeBytes: Buffer.byteLength(content),
      taskCount: data.count,
      eventCount: data.localEvents.length,
    };
  }

  /** Keeps the newest `keep` snapshots (and their JSON exports). */
  private prune(target: Extract<BackupTarget, { kind: 'file' }>) {
    const snapshots = fs
      .readdirSync(target.dir)
      .filter((f) => SNAPSHOT_RE.test(f))
      .sort()
      .reverse();
    for (const old of snapshots.slice(target.keep)) {
      for (const f of [old, `${old}-wal`, `${old}-shm`, old.replace(/\.db$/, '.json')])
        fs.rmSync(path.join(target.dir, f), { force: true });
    }
  }

  /**
   * Serverless: runs the nightly backup if its slot has passed with no good backup since, waiting
   * RETRY_AFTER_MS after a failure. Returns the run, or null when nothing was due.
   */
  async runIfDue(): Promise<BackupRunRow | null> {
    if (!this.o.enabled || this.running) return null;
    const slot = this.previousScheduledAt();
    const sinceSlot = await this.db
      .select()
      .from(backupRuns)
      .where(gte(backupRuns.startedAt, slot))
      .orderBy(desc(backupRuns.startedAt))
      .all();
    if (sinceSlot.some((r) => r.ok)) return null;
    const lastTry = sinceSlot[0];
    if (lastTry && this.now().getTime() - lastTry.startedAt.getTime() < RETRY_AFTER_MS) return null;
    return this.runNow('scheduled');
  }

  /**
   * Nightly schedule; catches up at startup if the last backup is >24h old.
   * Returns the catch-up run, if one was started.
   */
  async start(): Promise<BackupRunRow | null> {
    if (!this.o.enabled) return null;
    const set = this.o.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
    const scheduleNightly = () => {
      const ms = this.nextScheduledAt().getTime() - this.now().getTime();
      this.timers.push(
        set(() => {
          void this.runNow('scheduled').finally(scheduleNightly);
        }, ms),
      );
    };
    scheduleNightly();
    const good = await this.lastRun(true);
    if (!good || this.now().getTime() - good.finishedAt!.getTime() > 24 * HOUR) {
      return this.runNow('catch-up');
    }
    return null;
  }

  stop() {
    const clear = this.o.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    for (const t of this.timers) clear(t);
    this.timers.length = 0;
  }
}
