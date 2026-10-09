import { AgendaResponseSchema } from '@planner/shared';
import { describe, expect, it } from 'vitest';
import { fakeSource, makeTestEnv } from '../test/helpers';

// Oct 9 2026 in America/New_York (EDT, UTC-4); "now" is noon local.
const FROM = '2026-10-09T04:00:00.000Z';
const TO = '2026-10-10T04:00:00.000Z';

async function seeded() {
  const src = fakeSource('sync/agenda.json');
  const env = makeTestEnv([src], '2026-10-09T16:00:00.000Z');
  await env.scheduler.run('fake');
  return env;
}

const ids = (items: { item: { externalId: string } }[]) => items.map((i) => i.item.externalId);

describe('GET /api/agenda', () => {
  it('merges overlapping events and tasks due in range, sorted', async () => {
    const env = await seeded();
    const res = await env.json('GET', `/api/agenda?from=${FROM}&to=${TO}`);
    expect(res.status).toBe(200);
    const { items } = AgendaResponseSchema.parse(res.body);
    expect(ids(items)).toEqual([
      'e-span', // started yesterday, still running
      'e-allday', // all-day event before all-day task at the same instant
      't-call',
      'e-morning',
      't-morning',
      'e-lunch',
      't-hw',
    ]);
  });

  it('excludes boundary-touching events, undated tasks, and old tasks by default', async () => {
    const env = await seeded();
    const { body } = await env.json('GET', `/api/agenda?from=${FROM}&to=${TO}`);
    const got = ids(body.items);
    for (const id of ['e-before', 'e-after', 't-nodate', 't-old', 't-old-done']) {
      expect(got).not.toContain(id);
    }
  });

  it('flags overdue items and includes open overdue tasks on request', async () => {
    const env = await seeded();
    const { body } = await env.json('GET', `/api/agenda?from=${FROM}&to=${TO}&includeOverdue=true`);
    const { items } = AgendaResponseSchema.parse(body);
    expect(ids(items)[0]).toBe('t-old');
    expect(ids(items)).not.toContain('t-old-done');
    const overdue = items
      .filter((i) => i.kind === 'task' && i.overdue)
      .map((i) => i.item.externalId);
    // t-morning's 10am deadline has passed; t-call is date-only and still current today.
    expect(overdue).toEqual(['t-old', 't-morning']);
  });

  it('includes local tasks created through the API', async () => {
    const env = await seeded();
    await env.json('POST', '/api/tasks', {
      title: 'Pick up package',
      due: '2026-10-09T22:00:00Z',
      dueAllDay: false,
    });
    const { body } = await env.json('GET', `/api/agenda?from=${FROM}&to=${TO}`);
    expect(body.items.map((i: { item: { title: string } }) => i.item.title)).toContain(
      'Pick up package',
    );
  });

  it.each([
    ['missing params', ''],
    ['non-ISO from', `from=yesterday&to=${TO}`],
    ['from after to', `from=${TO}&to=${FROM}`],
    ['range too long', `from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z`],
    ['bad includeOverdue', `from=${FROM}&to=${TO}&includeOverdue=yes`],
  ])('returns 400 for %s', async (_name, qs) => {
    const env = await seeded();
    const res = await env.json('GET', `/api/agenda?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });
});
