import { TaskSchema } from '@planner/shared';
import { describe, expect, it } from 'vitest';
import { fakeSource, makeTestEnv } from '../../test/helpers';

describe('/api/tasks', () => {
  it('creates, reads, updates, completes, and deletes a local task', async () => {
    const env = await makeTestEnv([]);
    const created = await env.json('POST', '/api/tasks', {
      title: '  Buy shelf ',
      due: '2026-10-11T04:00:00Z',
      priority: 'high',
    });
    expect(created.status).toBe(201);
    const task = TaskSchema.parse(created.body.task);
    expect(task).toMatchObject({
      title: 'Buy shelf',
      source: 'local',
      externalId: task.id,
      status: 'todo',
    });

    expect((await env.json('GET', `/api/tasks/${task.id}`)).body.task.id).toBe(task.id);

    const done = await env.json('PATCH', `/api/tasks/${task.id}`, {
      status: 'done',
      title: 'Buy a shelf',
    });
    expect(done.body.task).toMatchObject({
      status: 'done',
      title: 'Buy a shelf',
      statusSetLocally: false,
    });
    expect(done.body.task.completedAt).toBe(env.now().toISOString());

    const reopened = await env.json('PATCH', `/api/tasks/${task.id}`, { status: 'todo' });
    expect(reopened.body.task.completedAt).toBeNull();

    expect((await env.json('DELETE', `/api/tasks/${task.id}`)).status).toBe(204);
    expect((await env.json('GET', `/api/tasks/${task.id}`)).status).toBe(404);
  });

  it('validates input', async () => {
    const env = await makeTestEnv([]);
    expect((await env.json('POST', '/api/tasks', { title: '' })).status).toBe(400);
    expect((await env.json('POST', '/api/tasks', { title: 'x', due: 'friday' })).status).toBe(400);
    const { body } = await env.json('POST', '/api/tasks', { title: 'x' });
    expect((await env.json('PATCH', `/api/tasks/${body.task.id}`, { bogus: 1 })).status).toBe(400);
  });

  it('only allows status/sortOrder edits on synced tasks, and never deletes them', async () => {
    const env = await makeTestEnv([fakeSource('sync/pages.json')]);
    await env.scheduler.run('fake');
    const { body } = await env.json('GET', '/api/tasks?source=canvas');
    const id = body.tasks[0].id;

    expect((await env.json('PATCH', `/api/tasks/${id}`, { title: 'hacked' })).status).toBe(403);
    expect((await env.json('PATCH', `/api/tasks/${id}`, { sortOrder: 5 })).status).toBe(200);
    expect((await env.json('DELETE', `/api/tasks/${id}`)).status).toBe(403);
  });

  it('filters by source and status', async () => {
    const env = await makeTestEnv([fakeSource('sync/pages.json')]);
    await env.scheduler.run('fake');
    await env.json('POST', '/api/tasks', { title: 'local one' });
    expect((await env.json('GET', '/api/tasks?source=local')).body.tasks).toHaveLength(1);
    expect((await env.json('GET', '/api/tasks?status=todo')).body.tasks).toHaveLength(2);
    expect((await env.json('GET', '/api/tasks?status=nope')).status).toBe(400);
  });
});
