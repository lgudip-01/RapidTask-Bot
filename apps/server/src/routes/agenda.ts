import { AgendaQuerySchema, type AgendaResponse } from '@planner/shared';
import { Hono } from 'hono';
import { queryAgenda } from '../agenda';
import type { AppDeps } from '../app';
import { badRequest } from '../http';

export function agendaRoutes({ db, now }: AppDeps) {
  return new Hono().get('/', async (c) => {
    const q = AgendaQuerySchema.safeParse(c.req.query());
    if (!q.success) return badRequest(c, q.error);
    const items = await queryAgenda(db, new Date(q.data.from), new Date(q.data.to), {
      includeOverdue: q.data.includeOverdue,
      now: now(),
    });
    return c.json<AgendaResponse>({ items });
  });
}
