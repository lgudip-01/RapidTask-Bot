import { HelloResponseSchema } from '@planner/shared';
import { describe, expect, it } from 'vitest';
import { createDb } from './db/client';
import { createApp } from './app';
import { SyncScheduler } from './sync/scheduler';

describe('GET /api/hello', () => {
  it('returns a valid hello payload', async () => {
    const db = createDb(':memory:');
    const app = createApp({ db, scheduler: new SyncScheduler(db, []), now: () => new Date() });
    const res = await app.request('/api/hello');
    expect(res.status).toBe(200);
    expect(HelloResponseSchema.parse(await res.json()).message).toBe('Hello from Planner');
  });
});
