import type { SyncStatus } from '@planner/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { toSyncStatusJson } from '../db/mappers';
import { syncState } from '../db/schema';
import { log, sanitizeError } from '../log';
import { applySyncBatch } from './upsert';
import type { SyncSource } from './types';

export class UnknownSourceError extends Error {}
export class AlreadyRunningError extends Error {}

export type RunOutcome =
  { ok: true; upserted: number; deleted: number } | { ok: false; error: string };

export interface SchedulerOptions {
  now?: () => Date;
  /** 0..1, for jitter. */
  random?: () => number;
  maxBackoffMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Called after a sync stores data, so open UIs refresh. */
  onChange?: (topic: 'sync') => void;
}

/** Delay before the next run: the interval on success, exponential backoff (capped, jittered) on failure. */
export function nextDelay(intervalMs: number, failures: number, maxMs: number, random: number) {
  if (failures === 0) return intervalMs;
  const base = Math.min(intervalMs * 2 ** failures, maxMs);
  return Math.round(base * (1 + 0.1 * random));
}

export class SyncScheduler {
  private readonly running = new Set<string>();
  private readonly timers = new Map<string, unknown>();
  private readonly bySource: Map<string, SyncSource>;
  private stopped = true;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly maxBackoffMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onChange?: (topic: 'sync') => void;

  constructor(
    private readonly db: Db,
    sources: SyncSource[],
    opts: SchedulerOptions = {},
  ) {
    this.bySource = new Map(sources.map((s) => [s.name, s]));
    this.now = opts.now ?? (() => new Date());
    this.random = opts.random ?? Math.random;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60 * 60_000;
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return t;
      });
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.onChange = opts.onChange;
  }

  has(name: string) {
    return this.bySource.has(name);
  }

  /** Schedules every source, resuming from a persisted `nextRunAt` (so backoff survives restarts). */
  start() {
    this.stopped = false;
    for (const name of this.bySource.keys()) {
      const next = this.state(name)?.nextRunAt;
      this.schedule(name, next ? Math.max(0, next.getTime() - this.now().getTime()) : 0);
    }
  }

  stop() {
    this.stopped = true;
    for (const h of this.timers.values()) this.clearTimer(h);
    this.timers.clear();
  }

  status(): SyncStatus[] {
    return [...this.bySource.keys()].map((name) =>
      toSyncStatusJson(name, this.state(name), this.running.has(name)),
    );
  }

  /** Runs one source now. Throws UnknownSourceError / AlreadyRunningError; source failures are returned, not thrown. */
  async run(name: string): Promise<RunOutcome> {
    const src = this.bySource.get(name);
    if (!src) throw new UnknownSourceError(name);
    if (this.running.has(name)) throw new AlreadyRunningError(name);
    this.running.add(name);
    let delay = src.intervalMs;
    try {
      const batch = await src.fetchSince(this.state(name)?.cursor ?? null);
      const res = applySyncBatch(this.db, src, batch, this.now());
      this.setNextRun(name, delay);
      log.info('sync ok', { source: name, upserted: res.upserted, deleted: res.deleted });
      if (res.upserted || res.deleted) this.onChange?.('sync');
      return { ok: true, ...res };
    } catch (e) {
      const error = sanitizeError(e);
      const failures = (this.state(name)?.consecutiveFailures ?? 0) + 1;
      delay = nextDelay(src.intervalMs, failures, this.maxBackoffMs, this.random());
      this.db
        .insert(syncState)
        .values({ source: name, lastError: error, consecutiveFailures: failures })
        .onConflictDoUpdate({
          target: syncState.source,
          set: { lastError: error, consecutiveFailures: failures },
        })
        .run();
      this.setNextRun(name, delay);
      log.warn('sync failed', { source: name, failures, error });
      return { ok: false, error };
    } finally {
      this.running.delete(name);
      if (!this.stopped) this.schedule(name, delay);
    }
  }

  private state(name: string) {
    return this.db.select().from(syncState).where(eq(syncState.source, name)).get();
  }

  private setNextRun(name: string, delayMs: number) {
    const nextRunAt = new Date(this.now().getTime() + delayMs);
    this.db
      .insert(syncState)
      .values({ source: name, nextRunAt })
      .onConflictDoUpdate({ target: syncState.source, set: { nextRunAt } })
      .run();
  }

  private schedule(name: string, delayMs: number) {
    const prev = this.timers.get(name);
    if (prev !== undefined) this.clearTimer(prev);
    this.timers.set(
      name,
      this.setTimer(() => {
        this.timers.delete(name);
        // A manual run in flight reschedules itself when it finishes.
        this.run(name).catch((e) => {
          if (!(e instanceof AlreadyRunningError))
            log.error('sync crashed', { source: name, error: sanitizeError(e) });
        });
      }, delayMs),
    );
  }
}
