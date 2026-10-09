import type { Context } from 'hono';
import type { z } from 'zod';

/** 400 response listing which fields failed, without echoing their values. */
export function badRequest(c: Context, error: z.ZodError) {
  return c.json(
    {
      error: 'invalid_request',
      issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    },
    400,
  );
}

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}
