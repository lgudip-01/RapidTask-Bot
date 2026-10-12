import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANVAS_BASE = 'https://canvas.example.edu';
export const CANVAS_TOKEN = 'canvas-test-token';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const canvasFixture = <T = unknown>(name: string): T =>
  JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as T;
export const canvasFixtureText = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

export interface FakeCanvasOptions {
  /** Link rel="next" from the first assignments page points at another host. */
  foreignNextLink?: boolean;
  /** First request answers 403 "Rate Limit Exceeded". */
  rateLimitFirst?: boolean;
  /** X-Rate-Limit-Remaining value on every response. */
  remaining?: number;
  /** Per-course assignment fixtures (course id → fixture pages). */
  assignments?: Record<string, string[]>;
  /** The only token /users/self accepts (default CANVAS_TOKEN). */
  validToken?: string;
}

/** Recorded-fixture Canvas API. Routes by path; follows the real pagination contract. */
export function fakeCanvasApi(opts: FakeCanvasOptions = {}) {
  const calls: { url: URL; authorization: string | null }[] = [];
  const assignments = opts.assignments ?? {
    '101': ['assignments-101-page1.json', 'assignments-101-page2.json'],
    '102': ['assignments-102.json'],
  };
  let rateLimited = !opts.rateLimitFirst;

  const json = (body: unknown, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-rate-limit-remaining': String(opts.remaining ?? 650),
        ...extra,
      },
    });

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    if (!rateLimited) {
      rateLimited = true;
      return new Response('403 Forbidden (Rate Limit Exceeded)', { status: 403 });
    }
    const p = url.pathname;
    const codes = url.searchParams.getAll('context_codes[]');

    if (p === '/api/v1/users/self') {
      return new Headers(init?.headers).get('authorization') ===
        `Bearer ${opts.validToken ?? CANVAS_TOKEN}`
        ? json({ id: '42', name: 'Test Student' })
        : new Response(JSON.stringify({ errors: [{ message: 'Invalid access token.' }] }), {
            status: 401,
          });
    }
    if (p === '/api/v1/courses') return json(canvasFixture('courses.json'));

    const one = /^\/api\/v1\/courses\/(\w+)\/assignments\/(\w+)$/.exec(p);
    if (one) {
      const found = (assignments[one[1]!] ?? [])
        .flatMap((f) => canvasFixture<{ id: string }[]>(f))
        .find((a) => a.id === one[2]);
      return found
        ? json(found)
        : new Response(JSON.stringify({ errors: [{ message: 'not found' }] }), { status: 404 });
    }

    const m = /^\/api\/v1\/courses\/(\w+)\/assignments$/.exec(p);
    if (m) {
      const pages = assignments[m[1]!] ?? [];
      const page = Number(url.searchParams.get('page') ?? '1');
      const body = pages[page - 1] ? canvasFixture(pages[page - 1]!) : [];
      if (page < pages.length) {
        const host = opts.foreignNextLink ? 'https://evil.example.com' : CANVAS_BASE;
        const next = `${host}${p}?include%5B%5D=submission&page=${page + 1}&per_page=100`;
        return json(body, {
          link: `<${CANVAS_BASE}${p}?page=${page}&per_page=100>; rel="current", <${next}>; rel="next", <${CANVAS_BASE}${p}?page=1&per_page=100>; rel="first"`,
        });
      }
      return json(body);
    }
    if (p === '/api/v1/calendar_events') {
      return json(
        canvasFixture<{ context_code: string }[]>('calendar-events.json').filter((e) =>
          codes.includes(e.context_code),
        ),
      );
    }
    if (p === '/api/v1/announcements') {
      return json(
        canvasFixture<{ context_code: string }[]>('announcements.json').filter((a) =>
          codes.includes(a.context_code),
        ),
      );
    }
    return new Response(JSON.stringify({ errors: [{ message: 'not found' }] }), { status: 404 });
  }) as typeof fetch;

  return Object.assign(fetchFn, { calls });
}
