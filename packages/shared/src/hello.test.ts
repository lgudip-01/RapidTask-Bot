import { describe, expect, it } from 'vitest';
import { HelloResponseSchema } from './hello';

describe('HelloResponseSchema', () => {
  it('accepts a valid payload', () => {
    expect(
      HelloResponseSchema.parse({ message: 'hi', time: '2026-10-09T12:00:00.000Z' }),
    ).toBeTruthy();
  });

  it('rejects a non-ISO time', () => {
    expect(HelloResponseSchema.safeParse({ message: 'hi', time: 'yesterday' }).success).toBe(false);
  });
});
