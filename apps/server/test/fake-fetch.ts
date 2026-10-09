import type { FetchFn } from '../src/google/oauth';

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export type FakeReply = { status: number; json?: unknown };

/** A fetch replacement that records requests and answers from a handler (no network). */
export function fakeFetch(handler: (req: RecordedRequest) => FakeReply) {
  const calls: RecordedRequest[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const raw = init?.body;
    let body: unknown = raw;
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    } else if (raw instanceof URLSearchParams) {
      body = Object.fromEntries(raw);
    }
    const req: RecordedRequest = {
      method: init?.method ?? 'GET',
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    };
    calls.push(req);
    const reply = handler(req);
    return new Response(reply.json === undefined ? null : JSON.stringify(reply.json), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as FetchFn;
  return Object.assign(fn, { calls });
}

export const staticAuth = () => {
  let invalidations = 0;
  return {
    accessToken: async () => 'test-access-token',
    invalidate: () => {
      invalidations++;
    },
    get invalidations() {
      return invalidations;
    },
  };
};
