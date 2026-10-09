import { addDays } from '@planner/shared';
import type { FetchFn } from '../google/oauth';
import type { SyncBatch, SyncItem, SyncSource } from '../sync/types';
import { canvasIds } from './canvas-normalize';
import { icsInstant, parseIcs } from './ics';

export interface CanvasIcsSourceOptions {
  /** The personal Canvas calendar feed URL. It is a bearer secret: never log it. */
  feedUrl: string;
  appTimeZone: string;
  intervalMs: number;
  now?: () => Date;
}

/** "Problem set 4 [PHYS 201]" → { title: "Problem set 4", course: "PHYS 201" } */
export function splitCourseSuffix(summary: string) {
  const m = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(summary);
  return m ? { title: m[1]!.trim(), course: m[2]!.trim() } : { title: summary, course: null };
}

/**
 * Fallback when personal access tokens are disabled: reads the Canvas calendar feed (.ics).
 * Assignments become tasks (status unknown → todo; tick them off locally), other entries events.
 * Uses the same externalIds as the REST source.
 */
export class CanvasIcsSource implements SyncSource {
  readonly name = 'canvas';
  readonly owns = { task: ['canvas' as const], event: ['canvas' as const] };
  readonly intervalMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly opts: CanvasIcsSourceOptions,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.intervalMs = opts.intervalMs;
    this.now = opts.now ?? (() => new Date());
  }

  async fetchSince(): Promise<SyncBatch> {
    const res = await this.fetchFn(this.opts.feedUrl, { headers: { accept: 'text/calendar' } });
    // Status only: the URL itself is a credential.
    if (!res.ok) throw new Error(`Canvas calendar feed returned ${res.status}`);
    const now = this.now();
    const tz = this.opts.appTimeZone;
    const items: SyncItem[] = [];

    for (const ev of parseIcs(await res.text(), tz)) {
      const { title, course } = splitCourseSuffix(ev.summary);
      const assignment = /assignment-(\d+)/.exec(ev.uid);
      const updatedAt = ev.lastModified ?? now;
      if (assignment) {
        const due = icsInstant(ev.start, tz);
        items.push({
          kind: 'task',
          data: {
            source: 'canvas',
            externalId: canvasIds.assignment(assignment[1]!),
            title: title || '(untitled assignment)',
            due,
            dueAllDay: 'date' in ev.start,
            status: 'todo',
            courseOrProject: course,
            url: ev.url,
            updatedAt,
          },
        });
        continue;
      }
      const id = /(\d+)\s*$/.exec(ev.uid)?.[1] ?? ev.uid;
      const allDay = 'date' in ev.start;
      const start = icsInstant(ev.start, tz);
      const end = ev.end
        ? icsInstant(ev.end, tz)
        : allDay
          ? icsInstant({ date: addDays((ev.start as { date: string }).date, 1) }, tz)
          : start;
      items.push({
        kind: 'event',
        data: {
          source: 'canvas',
          externalId: canvasIds.event(id),
          title: title || '(untitled event)',
          start,
          end,
          allDay,
          calendarName: course,
          url: ev.url,
          updatedAt,
        },
      });
    }

    return { items, nextCursor: now.toISOString(), fullResync: true };
  }
}
