import {
  NewTaskSchema,
  SourceSchema,
  TaskPatchSchema,
  TaskStatusSchema,
  type Task,
} from '@planner/shared';
import { and, asc, eq, max, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { toTaskJson } from '../db/mappers';
import { tasks } from '../db/schema';
import { badRequest, readJson } from '../http';

/** Fields that may change on tasks owned by another system (kept locally, never written back). */
const NON_LOCAL_EDITABLE = new Set(['status', 'sortOrder']);

const ListQuerySchema = z.object({
  source: SourceSchema.optional(),
  status: TaskStatusSchema.optional(),
});

export function taskRoutes({ db, now }: AppDeps) {
  const find = (id: string) => db.select().from(tasks).where(eq(tasks.id, id)).get();

  return new Hono()
    .get('/', async (c) => {
      const q = ListQuerySchema.safeParse(c.req.query());
      if (!q.success) return badRequest(c, q.error);
      const where: SQL[] = [];
      if (q.data.source) where.push(eq(tasks.source, q.data.source));
      if (q.data.status) where.push(eq(tasks.status, q.data.status));
      const rows = await db
        .select()
        .from(tasks)
        .where(and(...where))
        .orderBy(
          asc(tasks.sortOrder),
          sql`${tasks.due} IS NULL`,
          asc(tasks.due),
          asc(tasks.createdAt),
        )
        .all();
      return c.json<{ tasks: Task[] }>({ tasks: rows.map(toTaskJson) });
    })

    .get('/:id', async (c) => {
      const row = await find(c.req.param('id'));
      return row
        ? c.json<{ task: Task }>({ task: toTaskJson(row) })
        : c.json({ error: 'not_found' }, 404);
    })

    .post('/', async (c) => {
      const body = NewTaskSchema.safeParse(await readJson(c));
      if (!body.success) return badRequest(c, body.error);
      const t = body.data;
      const at = now();
      const id = randomUUID();
      const top =
        (
          await db
            .select({ v: max(tasks.sortOrder) })
            .from(tasks)
            .get()
        )?.v ?? 0;
      const row = await db
        .insert(tasks)
        .values({
          id,
          source: 'local',
          externalId: id,
          title: t.title,
          notes: t.notes ?? null,
          due: t.due ? new Date(t.due) : null,
          dueAllDay: t.dueAllDay,
          status: t.status,
          priority: t.priority ?? null,
          courseOrProject: t.courseOrProject ?? null,
          url: t.url ?? null,
          sortOrder: top + 1,
          createdAt: at,
          completedAt: t.status === 'done' ? at : null,
          updatedAt: at,
          syncedAt: at,
        })
        .returning()
        .get();
      return c.json<{ task: Task }>({ task: toTaskJson(row) }, 201);
    })

    .patch('/:id', async (c) => {
      const existing = await find(c.req.param('id'));
      if (!existing) return c.json({ error: 'not_found' }, 404);
      const body = TaskPatchSchema.safeParse(await readJson(c));
      if (!body.success) return badRequest(c, body.error);
      const p = body.data;

      const keys = Object.keys(p);
      if (existing.source !== 'local' && keys.some((k) => !NON_LOCAL_EDITABLE.has(k))) {
        return c.json(
          {
            error: 'read_only_source',
            message: `${existing.source} tasks only allow: ${[...NON_LOCAL_EDITABLE].join(', ')}`,
          },
          403,
        );
      }

      const at = now();
      const statusChanged = p.status !== undefined && p.status !== existing.status;
      const row = await db
        .update(tasks)
        .set({
          ...(p.title !== undefined && { title: p.title }),
          ...(p.notes !== undefined && { notes: p.notes }),
          ...(p.due !== undefined && { due: p.due ? new Date(p.due) : null }),
          ...(p.dueAllDay !== undefined && { dueAllDay: p.dueAllDay }),
          ...(p.priority !== undefined && { priority: p.priority }),
          ...(p.courseOrProject !== undefined && { courseOrProject: p.courseOrProject }),
          ...(p.url !== undefined && { url: p.url }),
          ...(p.sortOrder !== undefined && { sortOrder: p.sortOrder }),
          ...(statusChanged && {
            status: p.status,
            completedAt: p.status === 'done' ? at : null,
            statusSetLocally: existing.source !== 'local',
          }),
          updatedAt: at,
        })
        .where(eq(tasks.id, existing.id))
        .returning()
        .get();
      return c.json<{ task: Task }>({ task: toTaskJson(row!) });
    })

    .delete('/:id', async (c) => {
      const existing = await find(c.req.param('id'));
      if (!existing) return c.json({ error: 'not_found' }, 404);
      if (existing.source !== 'local') {
        return c.json(
          { error: 'read_only_source', message: 'only local tasks can be deleted' },
          403,
        );
      }
      await db.delete(tasks).where(eq(tasks.id, existing.id)).run();
      return c.body(null, 204);
    });
}
