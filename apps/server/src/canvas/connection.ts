import { CanvasClient, type CanvasClientOptions } from '@planner/canvas';
import type { FetchFn } from '../google/oauth';
import type { TokenStore } from '../secrets/token-store';
import type { SyncSource } from '../sync/types';

export const CANVAS_CONNECTION_KEY = 'canvas.connection';

export type CanvasCredentials =
  /** REST API: courses, assignments, events, announcements, grades. */
  | { kind: 'rest'; baseUrl: string; token: string }
  /** Calendar feed (Calendar → Calendar Feed): assignments and course events, no token. */
  | { kind: 'ics'; feedUrl: string };

/** Hostnames a Canvas address may never point at (the server would be calling itself or a LAN). */
function isPrivateHost(host: string) {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.startsWith('[')
  );
}

function httpsUrl(input: string): URL {
  // Canvas shows feeds as webcal:// in some places; it is the same https URL. (Swapped before
  // parsing: a parsed URL cannot switch from a custom scheme to https.)
  const s = input.replace(/^webcal:\/\//i, 'https://');
  const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  if (u.protocol !== 'https:') throw new Error('Canvas address must use https');
  if (isPrivateHost(u.hostname)) throw new Error('That is not a Canvas address');
  return u;
}

/** Normalizes what the owner typed ("school.instructure.com/courses") to an https origin. */
export function canvasOrigin(input: string): string {
  return httpsUrl(input.trim()).origin;
}

/** A Canvas calendar feed link: …/feeds/calendars/user_<secret>.ics */
export function looksLikeFeed(input: string) {
  return /\/feeds\/calendars\/[^/\s]+\.ics\b/i.test(input.trim());
}

/** Where a connection points, for display. Never the token or the feed's secret path. */
export const canvasHostOf = (c: CanvasCredentials) =>
  c.kind === 'rest' ? c.baseUrl : new URL(c.feedUrl).origin;

/**
 * A Canvas connection made from Settings (instead of CANVAS_* environment variables). It is kept
 * in the encrypted token store, never in plain settings; the token or feed link is only ever
 * sent to Canvas.
 */
export class CanvasConnectionStore {
  constructor(
    private readonly store: TokenStore,
    private readonly clientOptions: Partial<CanvasClientOptions> = {},
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async get(): Promise<CanvasCredentials | null> {
    const raw = await this.store.get(CANVAS_CONNECTION_KEY);
    if (!raw) return null;
    try {
      const c = JSON.parse(raw) as Partial<CanvasCredentials> & { baseUrl?: string };
      if (c.kind === 'ics') return c.feedUrl ? { kind: 'ics', feedUrl: c.feedUrl } : null;
      // Connections saved before feeds were supported have no `kind`.
      return c.baseUrl && 'token' in c && c.token
        ? { kind: 'rest', baseUrl: c.baseUrl, token: c.token }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Checks the connection with Canvas, then saves it: a token with GET /users/self, a feed by
   * fetching it. A feed link pasted into either field is treated as a feed.
   */
  async connect(input: {
    baseUrl?: string;
    token?: string;
    feedUrl?: string;
  }): Promise<{ name: string | null; kind: CanvasCredentials['kind'] }> {
    const feed = [input.feedUrl, input.token, input.baseUrl].find((s) => s && looksLikeFeed(s));
    if (feed) {
      const feedUrl = httpsUrl(feed.trim()).toString();
      const res = await this.fetchFn(feedUrl, { headers: { accept: 'text/calendar' } });
      const text = res.ok ? await res.text() : '';
      if (!res.ok) throw new CanvasFeedError(res.status);
      if (!text.trimStart().startsWith('BEGIN:VCALENDAR')) throw new CanvasFeedError(0);
      await this.save({ kind: 'ics', feedUrl });
      return { name: null, kind: 'ics' };
    }
    if (!input.baseUrl || !input.token) {
      throw new Error('Enter your Canvas address and an access token, or a calendar feed link');
    }
    const creds = {
      kind: 'rest' as const,
      baseUrl: canvasOrigin(input.baseUrl),
      token: input.token.trim(),
    };
    const me = await new CanvasClient({ ...this.clientOptions, ...creds }).getSelf();
    await this.save(creds);
    return { name: me.name, kind: 'rest' };
  }

  private save(c: CanvasCredentials) {
    return this.store.set(CANVAS_CONNECTION_KEY, JSON.stringify(c));
  }

  async disconnect() {
    await this.store.delete(CANVAS_CONNECTION_KEY);
  }
}

/** The calendar feed could not be read (status 0: it answered, but not with a calendar). */
export class CanvasFeedError extends Error {
  constructor(readonly status: number) {
    super(`Canvas calendar feed ${status || 'is not a calendar'}`);
    this.name = 'CanvasFeedError';
  }
}

/**
 * Keeps the scheduler's Canvas source in step with the stored connection. Serverless instances
 * start at different times, so each one re-checks before periodic work (`refresh`).
 */
export class CanvasRegistration {
  private current: string | null = null;

  constructor(
    private readonly connections: CanvasConnectionStore,
    private readonly scheduler: {
      addSource(s: SyncSource): void;
      removeSource(name: string): void;
    },
    private readonly makeSource: (c: CanvasCredentials) => SyncSource,
  ) {}

  /** Registers, replaces, or removes the Canvas source to match storage. */
  async refresh(): Promise<boolean> {
    const c = await this.connections.get();
    const id = c ? JSON.stringify(c) : null;
    if (id === this.current) return c !== null;
    this.scheduler.removeSource('canvas');
    if (c) this.scheduler.addSource(this.makeSource(c));
    this.current = id;
    return c !== null;
  }
}
