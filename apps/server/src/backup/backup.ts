import { addDays, dateInZone, zonedTimeToUtc } from '@planner/shared';
import Database from 'better-sqlite3';
import { asc, desc, eq } from 'drizzle-orm';
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
const ALERT_REPEAT_MS = 24 * HOUR;
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
}

/** Everything the owner created (all tasks + Planner-only events) as portable JSON. */
export function exportData(db: Db, now = new Date()) {
  const taskRows = db.select().from(tasks).orderBy(asc(tasks.source), asc(tasks.createdAt)).all();
  const eventRows = db
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
 * The online backup copies the WAL journal mode into the snapshot, so opening it would create
 * -wal/-shm side files. Switching it to a rollback journal makes the snapshot one self-contained file.
 */
function makeStandalone(file: string) {
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
}

/** Opens a snapshot read-only and checks it is an intact Planner database. */
export function verifySnapshot(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const check = db.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error(`integrity check failed: ${String(check)}`);
    const count = (table: string) =>
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { tasks: count('tasks'), events: count('calendar_events') };
  } finally {
    db.close();
  }
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

export interface BackupOptions {
  dir: string;
  keep: number;
  hour: number;
  timeZone: string;
  enabled: boolean;
  now?: () => Date;
  /** Sends the owner a message (Telegram). Absent: alerts are only logged. */
  alert?: (text: string) => Promise<void>;
  onChange?: (topic: ChangeTopic) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/**
 * Nightly backups: a consistent SQLite snapshot (online backup API) plus a JSON export, pruned to
 * the newest `keep`. An hourly health check alerts the owner when a backup failed or the newest
 * good one is older than 48 hours.
 */
export class BackupService {
  private running = false;
  private readonly startedAt: number;
  private readonly timers: unknown[] = [];
  private lastAlert: { health: BackupHealth; at: number } | null = null;
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

  recent(limit = 10): BackupRunRow[] {
    return this.db.select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(limit).all();
  }

  /** Next nightly run: BACKUP_HOUR:00 local time, today if still ahead, else tomorrow. */
  nextScheduledAt(): Date {
    const now = this.now();
    const today = dateInZone(now, this.o.timeZone);
    for (const day of [today, addDays(today, 1)]) {
      const [y, m, d] = day.split('-').map(Number);
      const at = zonedTimeToUtc(this.o.timeZone, y!, m!, d!, this.o.hour);
      if (at > now) return at;
    }
    throw new Error('unreachable');
  }

  status(): BackupStatus {
    const last = this.lastRun();
    const good = this.lastRun(true);
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
      keep: this.o.keep,
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
    this.db.insert(backupRuns).values({ id, reason, startedAt }).run();
    try {
      fs.mkdirSync(this.o.dir, { recursive: true });
      const base = `planner-${stamp(startedAt)}`;
      const file = path.join(this.o.dir, `${base}.db`);
      await this.db.$client.backup(file);
      makeStandalone(file);
      const counts = verifySnapshot(file);
      fs.writeFileSync(
        path.join(this.o.dir, `${base}.json`),
        JSON.stringify(exportData(this.db, startedAt), null, 2) + '\n',
        { mode: 0o600 },
      );
      this.prune();
      const row = this.db
        .update(backupRuns)
        .set({
          ok: true,
          finishedAt: this.now(),
          file: `${base}.db`,
          sizeBytes: fs.statSync(file).size,
          taskCount: counts.tasks,
          eventCount: counts.events,
        })
        .where(eq(backupRuns.id, id))
        .returning()
        .get()!;
      log.info('backup ok', { reason, sizeBytes: row.sizeBytes, tasks: counts.tasks });
      return row;
    } catch (e) {
      const error = sanitizeError(e);
      const row = this.db
        .update(backupRuns)
        .set({ ok: false, finishedAt: this.now(), error })
        .where(eq(backupRuns.id, id))
        .returning()
        .get()!;
      log.error('backup failed', { reason, error });
      return row;
    } finally {
      this.running = false;
      this.o.onChange?.('backup');
      await this.checkHealth();
    }
  }

  /** Keeps the newest `keep` snapshots (and their JSON exports). */
  private prune() {
    const snapshots = fs
      .readdirSync(this.o.dir)
      .filter((f) => SNAPSHOT_RE.test(f))
      .sort()
      .reverse();
    for (const old of snapshots.slice(this.o.keep)) {
      for (const f of [old, `${old}-wal`, `${old}-shm`, old.replace(/\.db$/, '.json')])
        fs.rmSync(path.join(this.o.dir, f), { force: true });
    }
  }

  /** Alerts on 'failed' or 'stale', at most once per state change or once a day. */
  async checkHealth(): Promise<BackupHealth> {
    const s = this.status();
    if (s.health !== 'failed' && s.health !== 'stale') {
      this.lastAlert = null;
      return s.health;
    }
    const t = this.now().getTime();
    if (
      this.lastAlert &&
      this.lastAlert.health === s.health &&
      t - this.lastAlert.at < ALERT_REPEAT_MS
    ) {
      return s.health;
    }
    this.lastAlert = { health: s.health, at: t };
    const since = s.lastSuccessAt
      ? `${Math.round((t - Date.parse(s.lastSuccessAt)) / HOUR)} hours ago`
      : 'never';
    const text =
      s.health === 'failed'
        ? `⚠️ Planner backup failed (${s.lastError ?? 'unknown error'}). Last good backup: ${since}. Open Settings → Backups.`
        : `⚠️ Planner backups are stale. Last good backup: ${since}. Open Settings → Backups.`;
    log.warn('backup health alert', { health: s.health });
    try {
      await this.o.alert?.(text);
    } catch (e) {
      log.error('backup alert could not be sent', { error: sanitizeError(e) });
    }
    return s.health;
  }

  /**
   * Nightly schedule + hourly health check; catches up at startup if the last backup is >24h old.
   * Returns the catch-up run, if one was started.
   */
  start(): Promise<BackupRunRow> | null {
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
    const scheduleHealth = () => {
      this.timers.push(
        set(() => {
          void this.checkHealth().finally(scheduleHealth);
        }, HOUR),
      );
    };
    scheduleNightly();
    scheduleHealth();
    const good = this.lastRun(true);
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
