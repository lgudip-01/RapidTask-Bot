import type { ParsedMessage } from '@planner/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { inboundHarness } from '../../test/inbound-harness';
import { calendarEvents, captures, inboundMessages, suggestions, tasks } from '../db/schema';
import type { ExtractionInput, LlmExtractor } from '../parser/claude-extractor';
import { HELP_TEXT, OFF_TOPIC_TEXT, parseCommand } from './commands';

const offTopic: ParsedMessage = {
  kind: 'off_topic',
  title: null,
  start: null,
  end: null,
  due: null,
  allDay: false,
  notes: null,
  confidence: 0.99,
  clarifyingQuestion: null,
};

const llmFrom = (fn: (i: ExtractionInput) => ParsedMessage): LlmExtractor => ({
  extract: async (i) => fn(i),
});

describe('commands', () => {
  it.each([
    ['UNDO', { type: 'undo' }],
    [' undo. ', { type: 'undo' }],
    ['Today', { type: 'today' }],
    ['help', { type: 'help' }],
    ['DONE 2', { type: 'done', n: 2 }],
    ['done #12', { type: 'done', n: 12 }],
    ['undo the dentist', null],
    ['done', null],
    ['today 5pm gym', null],
  ])('%j → %j', (text, cmd) => expect(parseCommand(text)).toEqual(cmd));

  it('HELP replies with the fixed help text', async () => {
    const h = inboundHarness();
    expect(await h.say('HELP')).toBe(HELP_TEXT);
  });

  it('UNDO removes the most recent capture, then has nothing left', async () => {
    const h = inboundHarness();
    await h.say('call mom tomorrow');
    await h.say('dentist tues 3pm');
    expect(await h.say('UNDO')).toBe('Removed: Dentist');
    expect(h.db.select().from(calendarEvents).all()).toHaveLength(0);
    expect(await h.say('undo')).toBe('Removed: Call mom');
    expect(h.db.select().from(tasks).all()).toHaveLength(0);
    expect(await h.say('UNDO')).toBe('Nothing to undo.');
  });

  it('TODAY lists events and numbers open tasks; DONE <n> checks one off', async () => {
    const h = inboundHarness();
    await h.say('gym 6pm');
    await h.say('submit form by 5pm');
    await h.json('POST', '/api/tasks', { title: 'Old thing', due: '2026-10-07T04:00:00Z' });
    await h.json('POST', '/api/tasks', { title: 'Tomorrow thing', due: '2026-10-10T04:00:00Z' });

    const today = await h.say('TODAY');
    expect(today).toBe(
      [
        'Today, Fri, Oct 9',
        '• 6:00 PM Gym',
        '1. Submit form — due 5:00 PM',
        'Overdue:',
        '2. Old thing (was due Wed, Oct 7)',
        'Reply DONE <n> to check one off.',
      ].join('\n'),
    );

    expect(await h.say('DONE 2')).toBe('Done: Old thing ✓');
    expect(h.db.select().from(tasks).where(eq(tasks.title, 'Old thing')).get()).toMatchObject({
      status: 'done',
    });
    expect(await h.say('DONE 2')).toBe('Already done: Old thing');
    expect(await h.say('DONE 9')).toBe("There's no task 9 on today's list. Send TODAY to see it.");
  });

  it('TODAY with nothing on', async () => {
    const h = inboundHarness();
    expect(await h.say('TODAY')).toBe('Today, Fri, Oct 9\nNothing scheduled.');
  });
});

describe('capture pipeline', () => {
  it('replies to off-topic messages with a fixed text and creates nothing', async () => {
    const h = inboundHarness({ llm: llmFrom(() => offTopic) });
    expect(await h.say('tell me a joke about calendars')).toBe(OFF_TOPIC_TEXT);
    expect(h.db.select().from(tasks).all()).toHaveLength(0);
    expect(h.db.select().from(inboundMessages).get()).toMatchObject({ outcome: 'off_topic' });
  });

  it('asks a clarifying question, files a suggestion, and completes on the answer', async () => {
    const h = inboundHarness({
      llm: llmFrom((i) =>
        i.clarification
          ? {
              ...offTopic,
              kind: 'event',
              title: 'Meeting',
              start: '2026-10-13T14:00',
              end: '2026-10-13T15:00',
              confidence: 0.9,
            }
          : {
              ...offTopic,
              kind: 'needs_clarification',
              title: 'Meeting',
              confidence: 0.6,
              clarifyingQuestion: 'When is the meeting?',
            },
      ),
    });
    expect(await h.say('meeting')).toBe('When is the meeting?');
    expect(h.db.select().from(suggestions).get()).toMatchObject({
      proposedTitle: 'Meeting',
      status: 'pending',
    });

    expect(await h.say('tues 2pm')).toBe(
      'Added to calendar: Meeting — Tue, Oct 13, 2:00–3:00 PM. Reply UNDO to remove.',
    );
    expect(h.db.select().from(suggestions).get()).toMatchObject({ status: 'accepted' });
  });

  it('rate limits per sender and records it', async () => {
    const h = inboundHarness({ rateLimit: { limit: 3, windowMs: 600_000 } });
    for (const t of ['HELP', 'HELP', 'HELP', 'HELP']) await h.say(t);
    expect(h.telegramReplies()).toHaveLength(3);
    const outcomes = h.db
      .select()
      .from(inboundMessages)
      .all()
      .map((r) => r.outcome);
    expect(outcomes.filter((o) => o === 'rate_limited')).toHaveLength(1);
  });

  it('never stores message text', async () => {
    const h = inboundHarness({ llm: llmFrom(() => offTopic) });
    await h.say('zebra-sentinel-42 says hello');
    await h.say('zebra-sentinel-43 call mom tomorrow');
    const dump = JSON.stringify([
      h.db.select().from(inboundMessages).all(),
      h.db.select().from(captures).all(),
      h.db.select().from(suggestions).all(),
    ]);
    expect(dump).not.toContain('zebra-sentinel-42');
    expect(dump).not.toContain('says hello');
    expect(
      h.db
        .select()
        .from(inboundMessages)
        .all()
        .map((r) => r.textLength),
    ).toEqual([28, 35]);
  });

  it('explains when the model is unavailable', async () => {
    const h = inboundHarness({
      llm: { extract: async () => Promise.reject(new Error('ECONNRESET')) },
    });
    expect(await h.say('buy milk')).toBe(
      "I couldn't process that right now. Please try again in a minute.",
    );
  });
});

describe('Google routing', () => {
  const googleEvent = (body: Record<string, unknown>) => ({
    id: 'gev1',
    status: 'confirmed',
    updated: '2026-10-09T16:00:00.000Z',
    summary: body.summary,
    start: body.start,
    end: body.end,
  });

  it('sends events to Google Calendar and tasks to Google Tasks; UNDO deletes upstream', async () => {
    const h = inboundHarness({
      google: {
        calendar: (req) =>
          req.method === 'DELETE'
            ? { status: 204 }
            : { status: 200, json: googleEvent(req.body as Record<string, unknown>) },
        tasks: (req) =>
          req.method === 'DELETE'
            ? { status: 204 }
            : {
                status: 200,
                json: {
                  id: 'gt1',
                  title: (req.body as { title: string }).title,
                  status: 'needsAction',
                  updated: '2026-10-09T16:00:00.000Z',
                },
              },
      },
    });

    expect(await h.say('dentist tues 3pm')).toContain('Added to calendar: Dentist');
    expect(h.googleCalendarApi!.calls[0]).toMatchObject({ method: 'POST' });
    expect(h.googleCalendarApi!.calls[0]!.body).toMatchObject({
      summary: 'Dentist',
      start: { dateTime: '2026-10-13T19:00:00.000Z', timeZone: 'America/New_York' },
    });
    expect(h.db.select().from(calendarEvents).get()).toMatchObject({
      source: 'google_calendar',
      externalId: 'primary/gev1',
    });

    expect(await h.say('call mom tomorrow')).toContain('Added task: Call mom');
    expect(h.googleTasksApi!.calls[0]!.url.pathname).toBe('/tasks/v1/lists/%40default/tasks');
    expect(h.googleTasksApi!.calls[0]!.body).toEqual({
      title: 'Call mom',
      due: '2026-10-10T00:00:00.000Z',
    });
    expect(h.db.select().from(tasks).get()).toMatchObject({
      source: 'google_tasks',
      externalId: '@default/gt1',
    });

    expect(await h.say('UNDO')).toBe('Removed: Call mom');
    expect(h.googleTasksApi!.calls.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(h.db.select().from(tasks).all()).toHaveLength(0);
  });

  it('falls back to local storage when Google fails, and says so', async () => {
    const h = inboundHarness({
      google: {
        calendar: () => ({ status: 503, json: {} }),
        tasks: () => ({ status: 503, json: {} }),
      },
    });
    expect(await h.say('dentist tues 3pm')).toBe(
      'Added to calendar: Dentist — Tue, Oct 13, 3:00–4:00 PM (saved in Planner; Google Calendar was unavailable). Reply UNDO to remove.',
    );
    expect(h.db.select().from(calendarEvents).get()).toMatchObject({ source: 'local' });
  });
});
