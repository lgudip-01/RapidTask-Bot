import { describe, expect, it } from 'vitest';
import { CANVAS_BASE, CANVAS_TOKEN, fakeCanvasApi } from '../test/fake-canvas';
import { CanvasClient, parseLinkHeader } from './client';
import type { CanvasAssignment } from './types';

function client(api: ReturnType<typeof fakeCanvasApi>, sleeps: number[] = []) {
  return new CanvasClient({
    baseUrl: CANVAS_BASE,
    token: CANVAS_TOKEN,
    fetch: api,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

describe('CanvasClient', () => {
  it('follows Link rel="next" until the last page', async () => {
    const api = fakeCanvasApi();
    const list = await client(api).listAssignments('101');
    expect(list.map((a: CanvasAssignment) => a.id)).toEqual([
      '1001',
      '1002',
      '1003',
      '1004',
      '1005',
      '1006',
      '1007',
    ]);
    expect(api.calls).toHaveLength(2);
    const first = api.calls[0]!.url;
    expect(first.searchParams.get('per_page')).toBe('100');
    expect(first.searchParams.getAll('include[]')).toEqual(['submission']);
    // The second request is exactly the opaque next URL.
    expect(api.calls[1]!.url.searchParams.get('page')).toBe('2');
  });

  it('sends the token only as a header, never in the URL', async () => {
    const api = fakeCanvasApi();
    await client(api).listCourses();
    expect(api.calls[0]!.authorization).toBe(`Bearer ${CANVAS_TOKEN}`);
    expect(api.calls[0]!.url.toString()).not.toContain(CANVAS_TOKEN);
  });

  it('refuses to follow a pagination link to another host', async () => {
    const api = fakeCanvasApi({ foreignNextLink: true });
    await expect(client(api).listAssignments('101')).rejects.toThrow(/different host/);
    expect(api.calls.every((c) => c.url.origin === CANVAS_BASE)).toBe(true);
  });

  it('backs off and retries after 403 Rate Limit Exceeded', async () => {
    const sleeps: number[] = [];
    const api = fakeCanvasApi({ rateLimitFirst: true });
    const courses = await client(api, sleeps).listCourses();
    expect(courses.length).toBeGreaterThan(0);
    expect(api.calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it('pauses when X-Rate-Limit-Remaining runs low', async () => {
    const sleeps: number[] = [];
    await client(fakeCanvasApi({ remaining: 40 }), sleeps).listCourses();
    expect(sleeps).toEqual([2000]);
    const relaxed: number[] = [];
    await client(fakeCanvasApi({ remaining: 650 }), relaxed).listCourses();
    expect(relaxed).toEqual([]);
  });

  it('throws on other errors with status only', async () => {
    const api = fakeCanvasApi();
    await expect(client(api).getAssignment('101', 'nope')).rejects.toThrow(
      /^Canvas GET \/api\/v1\/courses\/101\/assignments\/nope 404$/,
    );
  });

  it('chunks context codes into groups of 10', async () => {
    const api = fakeCanvasApi();
    const codes = Array.from({ length: 23 }, (_, i) => `course_${i}`);
    await client(api).listCalendarEvents(codes, new Date(), new Date());
    expect(api.calls.map((c) => c.url.searchParams.getAll('context_codes[]').length)).toEqual([
      10, 10, 3,
    ]);
  });

  it('requires https', () => {
    expect(() => new CanvasClient({ baseUrl: 'http://canvas.example.edu', token: 't' })).toThrow(
      /https/,
    );
  });

  it('parses Link headers case-insensitively', () => {
    expect(
      parseLinkHeader('<https://a/x?page=2>; REL="Next", <https://a/x?page=1>; rel=first'),
    ).toEqual({
      next: 'https://a/x?page=2',
      first: 'https://a/x?page=1',
    });
  });
});
