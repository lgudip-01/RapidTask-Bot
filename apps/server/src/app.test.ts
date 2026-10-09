import { HelloResponseSchema } from '@planner/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';

describe('GET /api/hello', () => {
  it('returns a valid hello payload', async () => {
    const res = await createApp().request('/api/hello');
    expect(res.status).toBe(200);
    expect(HelloResponseSchema.parse(await res.json()).message).toBe('Hello from Planner');
  });
});
