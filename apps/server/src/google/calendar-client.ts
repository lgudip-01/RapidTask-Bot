import type { AccessTokenProvider, FetchFn } from './oauth';

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

/** Fields of a Google Calendar event resource that we read. */
export interface GEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}
export interface GEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  updated?: string;
  start?: GEventTime;
  end?: GEventTime;
  recurringEventId?: string;
  eventType?: string;
}
export interface GEventList {
  summary?: string;
  timeZone?: string;
  items?: GEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/** Read-only REST client (GET only): injectable fetch for fixture tests, one retry after a 401. */
export class GoogleCalendarClient {
  constructor(
    private readonly auth: AccessTokenProvider,
    private readonly fetchFn: FetchFn = fetch,
    private readonly base = CALENDAR_API,
  ) {}

  /** GET only: this client has no way to modify Google data. */
  private async get<T>(
    pathname: string,
    query: Record<string, string | undefined>,
    retried = false,
  ): Promise<T> {
    const url = new URL(this.base + pathname);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${await this.auth.accessToken()}` },
    });
    if (res.status === 401 && !retried) {
      this.auth.invalidate();
      return this.get(pathname, query, true);
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as {
        error?: { message?: string; errors?: { reason?: string }[] };
      } | null;
      const reason = err?.error?.errors?.[0]?.reason;
      // Message only, no URL (it may contain tokens in query strings).
      throw new GoogleApiError(
        res.status,
        reason,
        `Google Calendar GET ${res.status}${reason ? ` ${reason}` : ''}`,
      );
    }
    return (await res.json()) as T;
  }

  private static eventsPath(calendarId: string) {
    return `/calendars/${encodeURIComponent(calendarId)}/events`;
  }

  listEvents(
    calendarId: string,
    q: { syncToken?: string; pageToken?: string; timeMin?: string },
  ): Promise<GEventList> {
    return this.get(GoogleCalendarClient.eventsPath(calendarId), {
      singleEvents: 'true',
      maxResults: '2500',
      syncToken: q.syncToken,
      pageToken: q.pageToken,
      timeMin: q.timeMin,
    });
  }
}
