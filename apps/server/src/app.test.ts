import { HelloResponseSchema } from '@planner/shared';
import { describe, expect, it } from 'vitest';
import { createDb } from './db/client';
import { createApp } from './app';
import { SettingsStore } from './settings';
import { SyncScheduler } from './sync/scheduler';

describe('GET /api/hello', () => {
  it('returns a valid hello payload', async () => {
    const db = createDb(':memory:');
    const now = () => new Date();
    const app = createApp({
      db,
      scheduler: new SyncScheduler(db, []),
      now,
      timeZone: 'America/New_York',
      settings: new SettingsStore(db, now),
    });
    const res = await app.request('/api/hello');
    expect(res.status).toBe(200);
    expect(HelloResponseSchema.parse(await res.json()).message).toBe('Hello from Planner');
  });
});
