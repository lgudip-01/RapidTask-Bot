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

export interface GEventWrite {
  summary?: string;
  description?: string | null;
  location?: string | null;
  start?: GEventTime;
  end?: GEventTime;
}

/** Thin REST client: injectable fetch for fixture tests, one retry after a 401. */
export class GoogleCalendarClient {
  constructor(
    private readonly auth: AccessTokenProvider,
    private readonly fetchFn: FetchFn = fetch,
    private readonly base = CALENDAR_API,
  ) {}

  private async call<T>(
    method: string,
    pathname: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown } = {},
    retried = false,
  ): Promise<T> {
    const url = new URL(this.base + pathname);
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, v);
    const res = await this.fetchFn(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.auth.accessToken()}`,
        ...(opts.body !== undefined && { 'content-type': 'application/json' }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (res.status === 401 && !retried) {
      this.auth.invalidate();
      return this.call(method, pathname, opts, true);
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
        `Google Calendar ${method} ${res.status}${reason ? ` ${reason}` : ''}`,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private static eventsPath(calendarId: string, eventId?: string) {
    const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
    return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
  }

  listEvents(
    calendarId: string,
    q: { syncToken?: string; pageToken?: string; timeMin?: string },
  ): Promise<GEventList> {
    return this.call('GET', GoogleCalendarClient.eventsPath(calendarId), {
      query: {
        singleEvents: 'true',
        maxResults: '2500',
        syncToken: q.syncToken,
        pageToken: q.pageToken,
        timeMin: q.timeMin,
      },
    });
  }

  insertEvent(calendarId: string, body: GEventWrite): Promise<GEvent> {
    return this.call('POST', GoogleCalendarClient.eventsPath(calendarId), { body });
  }

  patchEvent(calendarId: string, eventId: string, body: GEventWrite): Promise<GEvent> {
    return this.call('PATCH', GoogleCalendarClient.eventsPath(calendarId, eventId), { body });
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.call('DELETE', GoogleCalendarClient.eventsPath(calendarId, eventId));
  }
}
