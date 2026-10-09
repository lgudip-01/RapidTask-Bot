import { log } from '../log';
import type { SyncBatch, SyncItem, SyncSource } from '../sync/types';
import { GoogleApiError, type GEvent, type GoogleCalendarClient } from './calendar-client';
import { normalizeGoogleEvent } from './calendar-normalize';

export interface GoogleCalendarSourceOptions {
  calendarIds: string[];
  appTimeZone: string;
  intervalMs: number;
  /** How far back the initial full sync reaches. */
  lookbackDays: number;
  now?: () => Date;
}

/** Cursor = JSON map of calendarId → Google syncToken. */
type Cursor = Record<string, string>;

/**
 * Incremental sync with Calendar API sync tokens. If any calendar lacks a token, or Google
 * answers 410 Gone, every configured calendar is re-listed and the batch is a full re-sync.
 */
export class GoogleCalendarSource implements SyncSource {
  readonly name = 'google_calendar';
  readonly owns = { events: ['google_calendar' as const], tasks: [] };
  readonly intervalMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly client: GoogleCalendarClient,
    private readonly opts: GoogleCalendarSourceOptions,
  ) {
    this.intervalMs = opts.intervalMs;
    this.now = opts.now ?? (() => new Date());
  }

  async fetchSince(cursor: string | null): Promise<SyncBatch> {
    const tokens: Cursor = cursor ? JSON.parse(cursor) : {};
    if (this.opts.calendarIds.every((id) => tokens[id])) {
      try {
        return await this.sync(tokens);
      } catch (e) {
        if (!(e instanceof GoogleApiError && e.status === 410)) throw e;
        log.warn('google sync token expired; running full re-sync', { source: this.name });
      }
    }
    return this.sync(null);
  }

  /** `tokens` null = full sync. */
  private async sync(tokens: Cursor | null): Promise<SyncBatch> {
    const items: SyncItem[] = [];
    const next: Cursor = {};
    const timeMin = new Date(this.now().getTime() - this.opts.lookbackDays * 86_400_000);

    for (const calendarId of this.opts.calendarIds) {
      let pageToken: string | undefined;
      do {
        const page = await this.client.listEvents(calendarId, {
          syncToken: tokens?.[calendarId],
          // timeMin is only allowed on the initial (token-less) request.
          timeMin: tokens ? undefined : timeMin.toISOString(),
          pageToken,
        });
        const ctx = {
          calendarId,
          calendarName: page.summary ?? null,
          calendarTimeZone: page.timeZone ?? this.opts.appTimeZone,
          appTimeZone: this.opts.appTimeZone,
        };
        for (const ev of page.items ?? []) {
          const item = this.normalize(ev, ctx, tokens === null);
          if (item) items.push(item);
        }
        pageToken = page.nextPageToken;
        if (!pageToken) {
          if (!page.nextSyncToken) throw new Error('Google returned neither page nor sync token');
          next[calendarId] = page.nextSyncToken;
        }
      } while (pageToken);
    }

    return { items, nextCursor: JSON.stringify(next), fullResync: tokens === null };
  }

  private normalize(ev: GEvent, ctx: Parameters<typeof normalizeGoogleEvent>[1], full: boolean) {
    // A full listing has nothing to delete; cancelled entries there are noise.
    if (full && ev.status === 'cancelled') return null;
    try {
      return normalizeGoogleEvent(ev, ctx);
    } catch {
      log.warn('skipping malformed google event', { source: this.name });
      return null;
    }
  }
}
