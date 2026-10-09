import { contextCode, isCurrentCourse, type CanvasClient } from '@planner/canvas';
import type { SyncBatch, SyncItem, SyncSource } from '../sync/types';
import {
  announcementToInput,
  assignmentToTask,
  canvasEventToEvent,
  courseToInput,
} from './canvas-normalize';

export interface CanvasSourceOptions {
  baseUrl: string;
  appTimeZone: string;
  intervalMs: number;
  lookbackDays: number;
  lookaheadDays: number;
  includeGrades: boolean;
  now?: () => Date;
}

const DAY = 86_400_000;
const ANNOUNCEMENT_DAYS = 14;

/**
 * Read-only Canvas sync over the REST API. Canvas has no change tokens, so every run lists the
 * current term in full and is a `fullResync` (rows that disappeared upstream are removed).
 */
export class CanvasSource implements SyncSource {
  readonly name = 'canvas';
  readonly owns = {
    task: ['canvas' as const],
    event: ['canvas' as const],
    course: ['canvas' as const],
    announcement: ['canvas' as const],
  };
  readonly intervalMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly client: CanvasClient,
    private readonly opts: CanvasSourceOptions,
  ) {
    this.intervalMs = opts.intervalMs;
    this.now = opts.now ?? (() => new Date());
  }

  async fetchSince(): Promise<SyncBatch> {
    const now = this.now();
    const courses = (await this.client.listCourses()).filter((c) => isCurrentCourse(c, now));
    const nameByContext = new Map(courses.map((c) => [contextCode(c.id), c.name]));
    const items: SyncItem[] = [];

    for (const c of courses) {
      items.push({
        kind: 'course',
        data: courseToInput(c, this.opts.baseUrl, this.opts.includeGrades),
      });
      for (const a of await this.client.listAssignments(c.id)) {
        // Only dated, published assignments become tasks.
        if (!a.due_at || a.published === false) continue;
        items.push({ kind: 'task', data: assignmentToTask(a, c.name, now) });
      }
    }

    const codes = [...nameByContext.keys()];
    if (codes.length) {
      const from = new Date(now.getTime() - this.opts.lookbackDays * DAY);
      const to = new Date(now.getTime() + this.opts.lookaheadDays * DAY);
      for (const e of await this.client.listCalendarEvents(codes, from, to)) {
        const ev = canvasEventToEvent(
          e,
          nameByContext.get(e.context_code) ?? null,
          this.opts.appTimeZone,
          now,
        );
        if (ev) items.push({ kind: 'event', data: ev });
      }
      const since = new Date(now.getTime() - ANNOUNCEMENT_DAYS * DAY);
      for (const a of await this.client.listAnnouncements(codes, since, now)) {
        const ann = announcementToInput(a, nameByContext.get(a.context_code) ?? null);
        if (ann) items.push({ kind: 'announcement', data: ann });
      }
    }

    return { items, nextCursor: now.toISOString(), fullResync: true };
  }
}
