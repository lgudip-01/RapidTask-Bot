import type { ParsedMessage } from '@planner/shared';
import { describe, expect, it } from 'vitest';
import { makeTestEnv } from '../../test/helpers';
import { suggestions, tasks } from '../db/schema';
import { ItemCreator } from '../inbound/creator';
import type { ExtractionInput } from '../parser/claude-extractor';
import { MessageParser } from '../parser/parser';
import { SettingsStore } from '../settings';

const TZ = 'America/New_York';
const milk: ParsedMessage = {
  kind: 'task',
  title: 'Buy milk',
  start: null,
  end: null,
  due: null,
  allDay: true,
  notes: null,
  confidence: 0.9,
  clarifyingQuestion: null,
};

async function env() {
  const calls: ExtractionInput[] = [];
  const e = await makeTestEnv([], '2026-10-09T16:00:00.000Z', (db, now) => {
    const settings = new SettingsStore(db, now);
    return {
      capture: {
        parser: new MessageParser({
          llm: { extract: async (i) => (calls.push(i), milk) },
          llmEnabled: async () => (await settings.get()).aiTriage,
          timeZone: TZ,
          now,
        }),
        creator: new ItemCreator({ db, now }),
      },
    };
  });
  return { ...e, calls };
}

describe('settings', () => {
  it('defaults, patches, and validates', async () => {
    const e = await env();
    const defaults = {
      aiTriage: true,
      showGrades: false,
      digestEnabled: true,
      digestTime: '07:30',
      deadlineReminders: true,
      deadlineReminderTime: '19:00',
      eventReminders: true,
      eventReminderMinutes: 60,
    };
    expect((await e.json('GET', '/api/settings')).body.settings).toEqual(defaults);
    expect((await e.json('PATCH', '/api/settings', { showGrades: true })).body.settings).toEqual({
      ...defaults,
      showGrades: true,
    });
    expect(
      (await e.json('PATCH', '/api/settings', { digestTime: '06:45' })).body.settings,
    ).toMatchObject({ digestTime: '06:45', showGrades: true });
    expect((await e.json('PATCH', '/api/settings', { showGrades: 'yes' })).status).toBe(400);
    expect((await e.json('PATCH', '/api/settings', { digestTime: '7:30' })).status).toBe(400);
    expect((await e.json('PATCH', '/api/settings', { digestTime: '24:00' })).status).toBe(400);
    expect((await e.json('PATCH', '/api/settings', { eventReminderMinutes: 1 })).status).toBe(400);
    expect((await e.json('PATCH', '/api/settings', { admin: true })).status).toBe(400);
  });

  it('turning AI triage off stops model calls', async () => {
    const e = await env();
    await e.json('PATCH', '/api/settings', { aiTriage: false });
    const res = await e.json('POST', '/api/capture', { text: 'buy milk' });
    expect(res.status).toBe(422);
    expect(res.body.preview).toMatchObject({ type: 'error', reason: 'llm_disabled' });
    expect(e.calls).toHaveLength(0);
  });
});

describe('quick-add', () => {
  it('previews without calling the model or creating anything', async () => {
    const e = await env();
    const res = await e.json('POST', '/api/parse', { text: 'physics lab report thurs 5pm' });
    expect(res.body.preview).toEqual({
      type: 'capture',
      kind: 'task',
      title: 'Physics lab report',
      start: null,
      end: null,
      due: '2026-10-15T21:00:00.000Z',
      allDay: false,
      via: 'fast',
      summary: 'due Thu, Oct 15, 5:00 PM',
    });
    expect((await e.json('POST', '/api/parse', { text: 'buy milk' })).body.preview.type).toBe(
      'error',
    );
    expect(e.calls).toHaveLength(0);
    expect(await e.db.select().from(tasks).all()).toHaveLength(0);
  });

  it('captures with the model when needed', async () => {
    const e = await env();
    const res = await e.json('POST', '/api/capture', { text: 'buy milk' });
    expect(res.status).toBe(201);
    expect(res.body.created).toMatchObject({ kind: 'task', source: 'local', title: 'Buy milk' });
    expect(e.calls).toHaveLength(1);
  });
});

describe('suggestions', () => {
  async function seed(e: Awaited<ReturnType<typeof env>>) {
    await e.db
      .insert(suggestions)
      .values([
        {
          id: 's1',
          sourceMessageRef: 'telegram:1',
          proposedTitle: 'Meeting',
          confidence: 0.6,
          createdAt: new Date('2026-10-09T15:00:00Z'),
        },
        {
          id: 's2',
          sourceMessageRef: 'telegram:2',
          proposedTitle: 'Coffee',
          confidence: 0.5,
          createdAt: new Date('2026-10-09T15:30:00Z'),
        },
      ])
      .run();
  }

  it('lists pending, accepts an edited item, and dismisses', async () => {
    const e = await env();
    await seed(e);
    expect(
      (await e.json('GET', '/api/suggestions')).body.suggestions.map((s: { id: string }) => s.id),
    ).toEqual(['s2', 's1']);

    const accepted = await e.json('POST', '/api/suggestions/s1/accept', {
      kind: 'event',
      title: 'Team meeting',
      when: { allDay: false, start: '2026-10-13T18:00:00Z', end: '2026-10-13T19:00:00Z' },
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.created).toMatchObject({ kind: 'event', title: 'Team meeting' });
    expect(
      (
        await e.json('POST', '/api/suggestions/s1/accept', {
          kind: 'task',
          title: 'x',
          due: null,
          dueAllDay: true,
        })
      ).status,
    ).toBe(409);

    expect((await e.json('POST', '/api/suggestions/s2/dismiss')).status).toBe(204);
    expect((await e.json('GET', '/api/suggestions')).body.suggestions).toEqual([]);
    expect((await e.db.select().from(suggestions).all()).map((s) => s.status).sort()).toEqual([
      'accepted',
      'dismissed',
    ]);
  });
});

describe('search', () => {
  it('matches titles and treats % and _ literally', async () => {
    const e = await env();
    await e.json('POST', '/api/tasks', { title: 'Grade 100% done' });
    await e.json('POST', '/api/tasks', { title: 'Grade1000 done' });
    await e.json('POST', '/api/tasks', { title: 'file_name fix' });
    await e.json('POST', '/api/tasks', { title: 'filename fix' });
    const titles = async (q: string) =>
      (await e.json('GET', `/api/search?q=${encodeURIComponent(q)}`)).body.items.map(
        (i: { item: { title: string } }) => i.item.title,
      );
    expect(await titles('100%')).toEqual(['Grade 100% done']);
    expect(await titles('file_name')).toEqual(['file_name fix']);
    expect(await titles('GRADE')).toHaveLength(2);
    expect((await e.json('GET', '/api/search?q=')).status).toBe(400);
  });
});
