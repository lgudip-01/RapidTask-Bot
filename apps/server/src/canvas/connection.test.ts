import { CANVAS_BASE, fakeCanvasApi } from '@planner/canvas/testing';
import { describe, expect, it } from 'vitest';
import { makeTestEnv } from '../../test/helpers';
import { MemoryTokenStore } from '../secrets/token-store';
import type { SyncSource } from '../sync/types';
import {
  CANVAS_CONNECTION_KEY,
  CanvasConnectionStore,
  CanvasRegistration,
  canvasOrigin,
} from './connection';

const TOKEN = '7~abcdefghijklmnopqrstuvwxyz0123456789';

const stubSource = (baseUrl: string): SyncSource => ({
  name: 'canvas',
  intervalMs: 1_800_000,
  owns: { task: ['canvas'] },
  fetchSince: async () => ({ items: [], nextCursor: baseUrl }),
});

describe('canvasOrigin', () => {
  it('accepts what people paste and keeps only the https origin', () => {
    expect(canvasOrigin('school.instructure.com/courses/12')).toBe(
      'https://school.instructure.com',
    );
    expect(canvasOrigin('https://canvas.example.edu/')).toBe('https://canvas.example.edu');
  });

  it('refuses plain http and private addresses', () => {
    expect(() => canvasOrigin('http://canvas.example.edu')).toThrow(/https/);
    for (const bad of ['localhost', 'https://10.0.0.5', 'https://printer.local', 'https://[::1]'])
      expect(() => canvasOrigin(bad)).toThrow(/not a Canvas address/);
  });
});

describe('CanvasConnectionStore', () => {
  it('checks the token with Canvas before saving it', async () => {
    const store = new MemoryTokenStore();
    const api = fakeCanvasApi({ validToken: TOKEN });
    const conn = new CanvasConnectionStore(store, { fetch: api });
    expect(await conn.connect({ baseUrl: `${CANVAS_BASE}/courses`, token: ` ${TOKEN} ` })).toEqual({
      name: 'Test Student',
    });
    expect(await conn.get()).toEqual({ baseUrl: CANVAS_BASE, token: TOKEN });
    // Only a GET to the Canvas host, with the token as a bearer header.
    expect(api.calls.map((c) => [c.url.origin + c.url.pathname, c.authorization])).toEqual([
      [`${CANVAS_BASE}/api/v1/users/self`, `Bearer ${TOKEN}`],
    ]);
  });

  it('saves nothing when Canvas rejects the token', async () => {
    const store = new MemoryTokenStore();
    const conn = new CanvasConnectionStore(store, { fetch: fakeCanvasApi({ validToken: TOKEN }) });
    await expect(conn.connect({ baseUrl: CANVAS_BASE, token: 'x'.repeat(30) })).rejects.toThrow(
      /401/,
    );
    expect(await store.get(CANVAS_CONNECTION_KEY)).toBeNull();
  });
});

describe('CanvasRegistration', () => {
  it('adds, replaces and removes the scheduler source to match storage', async () => {
    const env = await makeTestEnv([]);
    const store = new MemoryTokenStore();
    const conn = new CanvasConnectionStore(store, { fetch: fakeCanvasApi({ validToken: TOKEN }) });
    const reg = new CanvasRegistration(conn, env.scheduler, (c) => stubSource(c.baseUrl));

    expect(await reg.refresh()).toBe(false);
    expect(env.scheduler.has('canvas')).toBe(false);

    await conn.connect({ baseUrl: CANVAS_BASE, token: TOKEN });
    expect(await reg.refresh()).toBe(true);
    expect(env.scheduler.has('canvas')).toBe(true);
    expect(await env.scheduler.run('canvas')).toMatchObject({ ok: true });

    await conn.disconnect();
    expect(await reg.refresh()).toBe(false);
    expect(env.scheduler.has('canvas')).toBe(false);
  });
});

describe('Connect Canvas routes', () => {
  async function setup() {
    const store = new MemoryTokenStore();
    const conn = new CanvasConnectionStore(store, { fetch: fakeCanvasApi({ validToken: TOKEN }) });
    let firstSyncs = 0;
    const env = await makeTestEnv([], undefined, (_db, _now) => ({
      canvas: {
        connection: async () => {
          const c = await conn.get();
          return {
            connected: Boolean(c),
            managed: c ? ('app' as const) : null,
            baseUrl: c?.baseUrl ?? null,
            canConnect: true,
          };
        },
        connect: async (input) => ({
          ...(await conn.connect(input)),
          firstSync: Promise.resolve(++firstSyncs),
        }),
        disconnect: () => conn.disconnect(),
      },
    }));
    return { env, store, firstSyncs: () => firstSyncs };
  }

  it('connects, reports the connection without the token, and disconnects', async () => {
    const s = await setup();
    expect((await s.env.json('GET', '/api/canvas/connection')).body).toEqual({
      connected: false,
      managed: null,
      baseUrl: null,
      canConnect: true,
    });
    const res = await s.env.json('POST', '/api/canvas/connect', {
      baseUrl: 'https://canvas.example.edu/courses',
      token: TOKEN,
    });
    expect(res).toEqual({ status: 200, body: { connected: true, name: 'Test Student' } });
    expect(s.firstSyncs()).toBe(1);

    const status = await s.env.json('GET', '/api/canvas/connection');
    expect(status.body).toEqual({
      connected: true,
      managed: 'app',
      baseUrl: CANVAS_BASE,
      canConnect: true,
    });
    expect(JSON.stringify(status.body)).not.toContain(TOKEN);

    expect((await s.env.json('POST', '/api/canvas/disconnect')).status).toBe(204);
    expect((await s.env.json('GET', '/api/canvas/connection')).body.connected).toBe(false);
  });

  it('explains a rejected token and a bad address, without echoing the token', async () => {
    const s = await setup();
    const rejected = await s.env.json('POST', '/api/canvas/connect', {
      baseUrl: CANVAS_BASE,
      token: 'y'.repeat(40),
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.message).toMatch(/rejected that token/);
    expect(JSON.stringify(rejected.body)).not.toContain('y'.repeat(40));

    const http = await s.env.json('POST', '/api/canvas/connect', {
      baseUrl: 'http://canvas.example.edu',
      token: TOKEN,
    });
    expect(http.status).toBe(400);
    expect(http.body.message).toMatch(/https/);

    // A bare host name is fine: the server adds https:// and keeps only the origin.
    const bare = await s.env.json('POST', '/api/canvas/connect', {
      baseUrl: 'canvas.example.edu',
      token: TOKEN,
    });
    expect(bare.status).toBe(200);
    expect(JSON.parse((await s.store.get(CANVAS_CONNECTION_KEY))!).baseUrl).toBe(CANVAS_BASE);
  });
});
