import {
  addDays,
  dateInZone,
  startOfDateInZone,
  zonedTimeToUtc,
  type Settings,
} from '@planner/shared';
import { and, eq, gt, gte, inArray, isNotNull, lt, lte, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { BackupStatus } from '../backup/backup';
import type { Db } from '../db/client';
import {
  calendarEvents,
  notifications,
  syncState,
  tasks,
  type NotificationRow,
} from '../db/schema';
import { formatDate, formatTime } from '../inbound/format';
import { buildTodayList } from '../inbound/today';
import { log, sanitizeError } from '../log';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** If the server was down at digest time, the digest still goes out within this window. */
export const DIGEST_GRACE_MS = 3 * HOUR;
/** Warn this long before the Canvas token expires. */
export const TOKEN_EXPIRY_WARNING_MS = 7 * DAY;
const SEND_ERROR_LOG_MS = 10 * MINUTE;

type Kind = NotificationRow['kind'];

const SOURCE_LABEL: Record<string, string> = {
  google_calendar: 'Google Calendar',
  canvas: 'Canvas',
};

export interface NotifierOptions {
  timeZone: string;
  settings: () => Settings | Promise<Settings>;
  /** Delivers one message to the owner (Telegram). Throwing means "not delivered, retry later". */
  send: (text: string) => Promise<void>;
  backupStatus?: () => BackupStatus | Promise<BackupStatus>;
  /** From CANVAS_TOKEN_EXPIRES_AT; enables the expiry warning. */
  canvasTokenExpiresAt?: Date;
  /** Consecutive failures of one sync source before an alert (default 3). */
  syncFailureThreshold?: number;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/** `hh:mm` on `date` (YYYY-MM-DD) in `timeZone`, as an instant (DST-aware). */
function wallTime(date: string, hhmm: string, timeZone: string) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return zonedTimeToUtc(timeZone, y!, m!, d!, h!, min!);
}

/**
 * Proactive messages to the owner, checked once a minute:
 * - daily digest at `digestTime`;
 * - deadline reminders the evening before (Canvas and Planner tasks) at `deadlineReminderTime`;
 * - event reminders `eventReminderMinutes` before each timed event;
 * - health alerts, at most once per condition per day.
 * Every message is claimed in `notifications` before sending, so nothing is sent twice.
 */
export class Notifier {
  private readonly now: () => Date;
  private timer: unknown = null;
  private ticking = false;
  private lastSendErrorLog = 0;

  constructor(
    private readonly db: Db,
    private readonly o: NotifierOptions,
  ) {
    this.now = o.now ?? (() => new Date());
  }

  /** Keys from `keys` not yet sent for `kind`. */
  private async unsent(kind: Kind, keys: string[]): Promise<string[]> {
    if (!keys.length) return [];
    const sent = new Set(
      (
        await this.db
          .select({ key: notifications.key })
          .from(notifications)
          .where(and(eq(notifications.kind, kind), inArray(notifications.key, keys)))
          .all()
      ).map((r) => r.key),
    );
    return keys.filter((k) => !sent.has(k));
  }

  /** Claims every key, sends, and releases the claims if delivery fails (retried next tick). */
  private async deliver(kind: Kind, keys: string[], text: string): Promise<boolean> {
    const rows = keys.map((key) => ({ id: randomUUID(), kind, key, sentAt: this.now() }));
    // One multi-row insert: all claims land together or not at all.
    await this.db.insert(notifications).values(rows).run();
    const ids = rows.map((r) => r.id);
    try {
      await this.o.send(text);
      log.info('notification sent', { kind, items: keys.length });
      return true;
    } catch (e) {
      await this.db.delete(notifications).where(inArray(notifications.id, ids)).run();
      const t = this.now().getTime();
      if (t - this.lastSendErrorLog > SEND_ERROR_LOG_MS) {
        this.lastSendErrorLog = t;
        log.warn('notification not delivered; will retry', { kind, error: sanitizeError(e) });
      }
      return false;
    }
  }

  private async digest(now: Date, s: Settings) {
    if (!s.digestEnabled) return;
    const today = dateInZone(now, this.o.timeZone);
    const due = wallTime(today, s.digestTime, this.o.timeZone);
    const late = now.getTime() - due.getTime();
    if (late < 0 || late > DIGEST_GRACE_MS) return;
    if (!(await this.unsent('digest', [today])).length) return;
    const list = await buildTodayList(this.db, now, this.o.timeZone);
    await this.deliver('digest', [today], `☀️ Good morning!\n${list.text}`);
  }

  private async deadlines(now: Date, s: Settings) {
    if (!s.deadlineReminders) return;
    const tz = this.o.timeZone;
    const today = dateInZone(now, tz);
    if (now < wallTime(today, s.deadlineReminderTime, tz)) return;
    const tomorrow = addDays(today, 1);
    const from = startOfDateInZone(tomorrow, tz);
    const to = startOfDateInZone(addDays(tomorrow, 1), tz);
    const rows = (
      await this.db
        .select()
        .from(tasks)
        .where(
          and(
            isNotNull(tasks.due),
            gte(tasks.due, from),
            lt(tasks.due, to),
            ne(tasks.status, 'done'),
          ),
        )
        .all()
    ).sort((a, b) => a.due!.getTime() - b.due!.getTime());
    const key = (t: (typeof rows)[number]) => `${t.id}@${t.due!.toISOString()}`;
    const pending = new Set(await this.unsent('deadline', rows.map(key)));
    const todo = rows.filter((t) => pending.has(key(t)));
    if (!todo.length) return;
    const lines = todo.map((t) => {
      const when = t.dueAllDay ? '' : ` — ${formatTime(t.due!, tz)}`;
      const where =
        t.source === 'canvas'
          ? ` (Canvas${t.courseOrProject ? `: ${t.courseOrProject}` : ''})`
          : '';
      return `• ${t.title}${when}${where}`;
    });
    await this.deliver(
      'deadline',
      todo.map(key),
      [`📌 Due tomorrow, ${formatDate(from, tz)}:`, ...lines].join('\n'),
    );
  }

  private async eventReminders(now: Date, s: Settings) {
    if (!s.eventReminders) return;
    const tz = this.o.timeZone;
    const horizon = new Date(now.getTime() + s.eventReminderMinutes * MINUTE);
    const rows = (
      await this.db
        .select()
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.allDay, false),
            gt(calendarEvents.start, now),
            lte(calendarEvents.start, horizon),
          ),
        )
        .all()
    ).sort((a, b) => a.start.getTime() - b.start.getTime());
    const key = (e: (typeof rows)[number]) => `${e.id}@${e.start.toISOString()}`;
    const pending = new Set(await this.unsent('event', rows.map(key)));
    const todo = rows.filter((e) => pending.has(key(e)));
    if (!todo.length) return;
    const lines = todo.map((e) => {
      const mins = Math.round((e.start.getTime() - now.getTime()) / MINUTE);
      const where = e.location ? ` @ ${e.location}` : '';
      return `• ${formatTime(e.start, tz)} ${e.title}${where} (in ${mins} min)`;
    });
    await this.deliver('event', todo.map(key), ['⏰ Coming up:', ...lines].join('\n'));
  }

  /** Active health problems, most specific first. */
  async healthConditions(now: Date): Promise<{ id: string; text: string }[]> {
    const out: { id: string; text: string }[] = [];
    const states = await this.db.select().from(syncState).all();
    const covered = new Set<string>();

    const google = states.find((r) => r.source === 'google_calendar');
    if (google?.lastError && /expired or revoked|invalid_grant/i.test(google.lastError)) {
      covered.add('google_calendar');
      out.push({
        id: 'google-auth',
        text: '⚠️ Google Calendar access was revoked or has expired, so calendar sync has stopped. Reconnect in Planner: Settings → Connect Google.',
      });
    }
    const canvas = states.find((r) => r.source === 'canvas');
    if (canvas?.lastError && /\b(401|403)\b/.test(canvas.lastError)) {
      covered.add('canvas');
      out.push({
        id: 'canvas-token',
        text: '⚠️ Canvas is refusing Planner’s requests (HTTP 401/403), so Canvas sync has stopped. The access token was probably revoked or expired: create a new one in Canvas → Account → Settings and update CANVAS_TOKEN.',
      });
    }
    const expires = this.o.canvasTokenExpiresAt;
    if (expires && expires.getTime() - now.getTime() <= TOKEN_EXPIRY_WARNING_MS) {
      const days = Math.ceil((expires.getTime() - now.getTime()) / DAY);
      out.push({
        id: 'canvas-token-expiry',
        text:
          days <= 0
            ? `⚠️ Your Canvas access token expired on ${formatDate(expires, this.o.timeZone)}. Create a new one and update CANVAS_TOKEN and CANVAS_TOKEN_EXPIRES_AT.`
            : `⏳ Your Canvas access token expires ${formatDate(expires, this.o.timeZone)} (in ${days} day${days === 1 ? '' : 's'}). Create a new one before then and update CANVAS_TOKEN and CANVAS_TOKEN_EXPIRES_AT.`,
      });
    }
    const threshold = this.o.syncFailureThreshold ?? 3;
    for (const r of states) {
      if (covered.has(r.source) || r.consecutiveFailures < threshold) continue;
      out.push({
        id: `sync-failing:${r.source}`,
        text: `⚠️ ${SOURCE_LABEL[r.source] ?? r.source} sync has failed ${r.consecutiveFailures} times in a row. Last error: ${r.lastError ?? 'unknown'}`,
      });
    }

    const b = await this.o.backupStatus?.();
    if (b && (b.health === 'failed' || b.health === 'stale')) {
      const since = b.lastSuccessAt
        ? `${Math.round((now.getTime() - Date.parse(b.lastSuccessAt)) / HOUR)} hours ago`
        : 'never';
      out.push({
        id: `backup-${b.health}`,
        text:
          b.health === 'failed'
            ? `⚠️ Planner backup failed (${b.lastError ?? 'unknown error'}). Last good backup: ${since}. Open Settings → Backups.`
            : `⚠️ Planner backups are stale. Last good backup: ${since}. Open Settings → Backups.`,
      });
    }
    return out;
  }

  private async health(now: Date) {
    const today = dateInZone(now, this.o.timeZone);
    for (const c of await this.healthConditions(now)) {
      const key = `${c.id}@${today}`;
      if ((await this.unsent('health', [key])).length) await this.deliver('health', [key], c.text);
    }
  }

  /** One pass over every kind of message. Safe to call at any time; never throws. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const s = await this.o.settings();
      for (const [name, step] of [
        ['digest', () => this.digest(now, s)],
        ['deadlines', () => this.deadlines(now, s)],
        ['events', () => this.eventReminders(now, s)],
        ['health', () => this.health(now)],
      ] as const) {
        try {
          await step();
        } catch (e) {
          log.error('notifier step failed', { step: name, error: sanitizeError(e) });
        }
      }
      // Keep the claim log small.
      await this.db
        .delete(notifications)
        .where(lt(notifications.sentAt, new Date(now.getTime() - 90 * DAY)))
        .run();
    } finally {
      this.ticking = false;
    }
  }

  /** Checks immediately, then every minute. */
  start() {
    const set = this.o.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
    const loop = () => {
      this.timer = set(() => void this.tick().finally(loop), MINUTE);
    };
    void this.tick().finally(loop);
  }

  stop() {
    const clear = this.o.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    if (this.timer) clear(this.timer);
    this.timer = null;
  }
}
