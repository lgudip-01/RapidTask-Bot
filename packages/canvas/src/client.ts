import type {
  CanvasAnnouncement,
  CanvasAssignment,
  CanvasCalendarEvent,
  CanvasCourse,
} from './types';

type FetchFn = typeof fetch;
type Params = Record<string, string | string[] | undefined>;

export class CanvasApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CanvasApiError';
  }
}

export interface CanvasClientOptions {
  /** e.g. https://canvas.example.edu (no trailing /api). */
  baseUrl: string;
  /** Personal access token. Sent only as a header, only to `baseUrl`'s origin. */
  token: string;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  /** Pause when X-Rate-Limit-Remaining drops below this (Canvas bucket starts at 700). */
  minRemaining?: number;
  throttleMs?: number;
  /** Retries after a 403 "Rate Limit Exceeded". */
  maxRetries?: number;
  perPage?: number;
}

/** Parses an RFC 8288 Link header into rel → URL. Header names are case-insensitive upstream. */
export function parseLinkHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/i.exec(part.trim());
    if (m) out[m[2]!.toLowerCase()] = m[1]!;
  }
  return out;
}

/** Read-only Canvas REST client: GET only, follows Link pagination, honours throttling. */
export class CanvasClient {
  private readonly origin: string;
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minRemaining: number;
  private readonly throttleMs: number;
  private readonly maxRetries: number;
  private readonly perPage: number;

  constructor(private readonly opts: CanvasClientOptions) {
    const u = new URL(opts.baseUrl);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !local) throw new Error('CANVAS_BASE_URL must use https');
    this.origin = u.origin;
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.minRemaining = opts.minRemaining ?? 100;
    this.throttleMs = opts.throttleMs ?? 2_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.perPage = opts.perPage ?? 100;
  }

  private url(path: string, params: Params = {}) {
    const u = new URL(`/api/v1${path}`, this.origin);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      for (const x of Array.isArray(v) ? v : [v]) u.searchParams.append(k, x);
    }
    return u;
  }

  private async get(url: URL): Promise<Response> {
    if (url.origin !== this.origin) {
      // Never send the token anywhere else, even if a Link header points elsewhere.
      throw new CanvasApiError(0, 'Canvas pagination link points to a different host');
    }
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(url, {
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          accept: 'application/json+canvas-string-ids',
        },
      });
      if (res.status === 403 && attempt < this.maxRetries) {
        const body = await res.clone().text();
        if (/rate limit exceeded/i.test(body)) {
          await this.sleep(this.throttleMs * 2 ** attempt);
          continue;
        }
      }
      if (!res.ok) throw new CanvasApiError(res.status, `Canvas GET ${url.pathname} ${res.status}`);
      const remaining = Number(res.headers.get('x-rate-limit-remaining'));
      if (res.headers.has('x-rate-limit-remaining') && remaining < this.minRemaining) {
        await this.sleep(this.throttleMs);
      }
      return res;
    }
  }

  /** GETs every page of a list endpoint. */
  async getAll<T>(path: string, params: Params = {}): Promise<T[]> {
    const out: T[] = [];
    let next: URL | null = this.url(path, { per_page: String(this.perPage), ...params });
    while (next) {
      const res = await this.get(next);
      out.push(...((await res.json()) as T[]));
      const link = parseLinkHeader(res.headers.get('link')).next;
      next = link ? new URL(link) : null;
    }
    return out;
  }

  async getOne<T>(path: string, params: Params = {}): Promise<T> {
    return (await (await this.get(this.url(path, params))).json()) as T;
  }

  listCourses(): Promise<CanvasCourse[]> {
    return this.getAll('/courses', {
      enrollment_state: 'active',
      'include[]': ['term', 'total_scores', 'concluded'],
    });
  }

  listAssignments(courseId: string): Promise<CanvasAssignment[]> {
    return this.getAll(`/courses/${encodeURIComponent(courseId)}/assignments`, {
      'include[]': ['submission'],
      order_by: 'due_at',
    });
  }

  getAssignment(courseId: string, assignmentId: string): Promise<CanvasAssignment> {
    return this.getOne(
      `/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}`,
      { 'include[]': ['submission'] },
    );
  }

  /** Calendar events for up to 10 contexts per request (Canvas limit); chunks automatically. */
  async listCalendarEvents(contextCodes: string[], start: Date, end: Date) {
    const out: CanvasCalendarEvent[] = [];
    for (const chunk of chunks(contextCodes, 10)) {
      out.push(
        ...(await this.getAll<CanvasCalendarEvent>('/calendar_events', {
          type: 'event',
          'context_codes[]': chunk,
          start_date: start.toISOString(),
          end_date: end.toISOString(),
        })),
      );
    }
    return out;
  }

  async listAnnouncements(contextCodes: string[], start: Date, end: Date) {
    const out: CanvasAnnouncement[] = [];
    for (const chunk of chunks(contextCodes, 10)) {
      out.push(
        ...(await this.getAll<CanvasAnnouncement>('/announcements', {
          'context_codes[]': chunk,
          start_date: start.toISOString().slice(0, 10),
          end_date: end.toISOString().slice(0, 10),
        })),
      );
    }
    return out;
  }
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
