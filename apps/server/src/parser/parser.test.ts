import { ParsedMessageSchema, type ParsedMessage } from '@planner/shared';
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/helpers';
import {
  ExtractorOutputError,
  ExtractorRefusalError,
  type ExtractionInput,
  type LlmExtractor,
} from './claude-extractor';
import { CLARIFICATION_TTL_MS, MessageParser, type ParseOutcome } from './parser';

interface Case {
  text: string;
  via?: 'fast' | 'llm';
  llm?: ParsedMessage;
  expect: Record<string, unknown>;
}
const table = loadFixture<{ now: string; cases: Case[] }>('parser/cases.json');
const TZ = 'America/New_York';

/** Mocked model: answers from a lookup and records what it was asked. */
function mockLlm(answer: (input: ExtractionInput) => unknown) {
  const calls: ExtractionInput[] = [];
  const llm: LlmExtractor = {
    async extract(input) {
      calls.push(input);
      const out = answer(input);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return { llm, calls };
}

function parserAt(iso: string, llm: LlmExtractor | null) {
  let t = Date.parse(iso);
  const parser = new MessageParser({ llm, timeZone: TZ, now: () => new Date(t) });
  return { parser, advance: (ms: number) => (t += ms) };
}

/** Flattens an outcome into the shape the table uses. */
function summarize(o: ParseOutcome) {
  if (o.type !== 'capture') return o;
  const i = o.item;
  return i.kind === 'event'
    ? {
        type: 'capture',
        kind: 'event',
        title: i.title,
        start: i.start.toISOString(),
        end: i.end.toISOString(),
        allDay: i.allDay,
      }
    : {
        type: 'capture',
        kind: 'task',
        title: i.title,
        due: i.due?.toISOString() ?? null,
        allDay: i.dueAllDay,
      };
}

describe(`parser table (${table.cases.length} messages)`, () => {
  it('has at least 30 cases', () => expect(table.cases.length).toBeGreaterThanOrEqual(30));

  it.each(table.cases.map((c) => [c.text, c] as const))('%s', async (_text, c) => {
    const { llm, calls } = mockLlm((input) => {
      if (!c.llm) throw new Error(`model should not be called for "${input.text}"`);
      return c.llm;
    });
    const { parser } = parserAt(table.now, llm);
    const out = await parser.parse('owner', c.text);

    expect(summarize(out)).toMatchObject(c.expect);
    if (c.via === 'fast') expect(calls).toHaveLength(0);
    if (c.via === 'llm') expect(calls).toHaveLength(1);
    if (out.type === 'capture' && c.via) expect(out.via).toBe(c.via);
  });
});

const valid: ParsedMessage = {
  kind: 'event',
  title: 'Dentist',
  start: '2026-10-13T15:00',
  end: '2026-10-13T16:00',
  due: null,
  allDay: false,
  notes: null,
  confidence: 0.9,
  clarifyingQuestion: null,
};

describe('model output validation', () => {
  it.each([
    ['missing end on an event', { ...valid, end: null }],
    ['extra key', { ...valid, action: 'delete_all' }],
    ['confidence above 1', { ...valid, confidence: 1.5 }],
    ['impossible date', { ...valid, start: '2026-02-30T10:00', end: '2026-02-30T11:00' }],
    ['UTC timestamp instead of local wall time', { ...valid, start: '2026-10-13T19:00:00Z' }],
    ['allDay mismatched with a timed start', { ...valid, allDay: true }],
    ['off_topic carrying a title', { ...valid, kind: 'off_topic', start: null, end: null }],
    [
      'clarification without a question',
      { ...valid, kind: 'needs_clarification', start: null, end: null },
    ],
    ['task with a start time', { ...valid, kind: 'task' }],
    ['question on a capture', { ...valid, clarifyingQuestion: 'ok?' }],
    ['title too long', { ...valid, title: 'x'.repeat(201) }],
    [
      'question too long',
      {
        ...valid,
        kind: 'needs_clarification',
        start: null,
        end: null,
        clarifyingQuestion: 'q'.repeat(161),
      },
    ],
    ['unknown kind', { ...valid, kind: 'delete' }],
    ['not an object', 'create event'],
  ])('rejects %s', async (_name, output) => {
    expect(ParsedMessageSchema.safeParse(output).success).toBe(false);
    const { llm } = mockLlm(() => output);
    const { parser } = parserAt(table.now, llm);
    expect(await parser.parse('owner', 'something the fast path skips')).toEqual({
      type: 'error',
      reason: 'invalid_output',
    });
  });

  it('accepts the valid baseline', () => {
    expect(ParsedMessageSchema.safeParse(valid).success).toBe(true);
  });

  it('maps extractor failures to error outcomes', async () => {
    for (const [err, reason] of [
      [new ExtractorOutputError('not JSON'), 'invalid_output'],
      [new ExtractorRefusalError('declined'), 'refused'],
      [new Error('ECONNRESET'), 'unavailable'],
    ] as const) {
      const { parser } = parserAt(table.now, mockLlm(() => err).llm);
      expect(await parser.parse('owner', 'buy milk')).toEqual({ type: 'error', reason });
    }
  });

  it('rejects dates too far out and overly long messages without calling the model', async () => {
    const { llm, calls } = mockLlm(() => ({
      ...valid,
      start: '2031-01-01T09:00',
      end: '2031-01-01T10:00',
    }));
    const { parser } = parserAt(table.now, llm);
    expect(await parser.parse('owner', 'something far away')).toEqual({
      type: 'error',
      reason: 'out_of_range',
    });
    expect(await parser.parse('owner', 'x'.repeat(501))).toEqual({
      type: 'error',
      reason: 'too_long',
    });
    expect(calls).toHaveLength(1);
  });

  it('works without the model for fast-path messages, and says so otherwise', async () => {
    const { parser } = parserAt(table.now, null);
    expect((await parser.parse('owner', 'call mom tomorrow')).type).toBe('capture');
    expect(await parser.parse('owner', 'buy milk')).toEqual({
      type: 'error',
      reason: 'llm_disabled',
    });
  });
});

describe('clarification flow', () => {
  const ask: ParsedMessage = {
    kind: 'needs_clarification',
    title: 'Meeting',
    start: null,
    end: null,
    due: null,
    allDay: false,
    notes: null,
    confidence: 0.6,
    clarifyingQuestion: 'When is the meeting?',
  };

  it('holds the question and reads the next message as the answer', async () => {
    const { llm, calls } = mockLlm((input) =>
      input.clarification
        ? { ...valid, title: 'Meeting', start: '2026-10-13T14:00', end: '2026-10-13T15:00' }
        : ask,
    );
    const { parser } = parserAt(table.now, llm);

    expect(await parser.parse('owner', 'meeting')).toEqual({
      type: 'clarify',
      question: 'When is the meeting?',
      proposedTitle: 'Meeting',
      confidence: 0.6,
    });
    expect(parser.hasPending('owner')).toBe(true);
    expect(parser.hasPending('someone-else')).toBe(false);

    // "tues 2pm" alone would hit the fast path; as an answer it must go to the model with context.
    const out = await parser.parse('owner', 'tues 2pm');
    expect(calls[1]).toMatchObject({
      text: 'tues 2pm',
      clarification: { earlierText: 'meeting', question: 'When is the meeting?' },
    });
    expect(summarize(out)).toMatchObject({
      kind: 'event',
      title: 'Meeting',
      start: '2026-10-13T18:00:00.000Z',
    });
    expect(parser.hasPending('owner')).toBe(false);
  });

  it('forgets the question after 10 minutes', async () => {
    const { llm, calls } = mockLlm(() => ask);
    const { parser, advance } = parserAt(table.now, llm);
    await parser.parse('owner', 'meeting');
    advance(CLARIFICATION_TTL_MS + 1);
    expect(parser.hasPending('owner')).toBe(false);
    const out = await parser.parse('owner', 'call mom tomorrow');
    expect(out.type).toBe('capture'); // fast path again, no context
    expect(calls).toHaveLength(1);
  });

  it('gives up after two rounds of questions', async () => {
    const { parser } = parserAt(table.now, mockLlm(() => ask).llm);
    expect((await parser.parse('owner', 'meeting')).type).toBe('clarify');
    expect((await parser.parse('owner', 'soon')).type).toBe('clarify');
    expect(await parser.parse('owner', 'idk')).toEqual({ type: 'error', reason: 'unresolved' });
    expect(parser.hasPending('owner')).toBe(false);
  });

  it('an off-topic answer clears the pending question', async () => {
    const offTopic = { ...ask, kind: 'off_topic', title: null, clarifyingQuestion: null };
    let n = 0;
    const { parser } = parserAt(table.now, mockLlm(() => (n++ === 0 ? ask : offTopic)).llm);
    await parser.parse('owner', 'meeting');
    expect(await parser.parse('owner', 'never mind')).toEqual({ type: 'off_topic' });
    expect(parser.hasPending('owner')).toBe(false);
  });
});

describe('time zone and DST edge cases (fast path, America/New_York)', () => {
  const noLlm = mockLlm(() => new Error('model should not be called')).llm;

  it.each([
    // DST ends Sun 2026-11-01 02:00 EDT → 01:00 EST.
    ['2026-10-31T16:00:00Z', 'brunch tomorrow 11am', '2026-11-01T16:00:00.000Z'],
    ['2026-10-31T16:00:00Z', 'check smoke alarm tomorrow 1:30am', '2026-11-01T05:30:00.000Z'], // ambiguous: first (EDT)
    ['2026-10-31T16:00:00Z', 'standup mon 9am', '2026-11-02T14:00:00.000Z'],
    // DST starts Sun 2026-03-08 02:00 EST → 03:00 EDT.
    ['2026-03-07T17:00:00Z', 'early run tomorrow 2:30am', '2026-03-08T07:30:00.000Z'], // nonexistent: 3:30 EDT
    ['2026-03-07T17:00:00Z', 'yoga tomorrow 9am', '2026-03-08T13:00:00.000Z'],
    // Late evening local time is already the next day in UTC.
    ['2026-10-10T02:30:00Z', 'gym 11pm', '2026-10-10T03:00:00.000Z'],
  ])('now=%s "%s" → %s', async (now, text, startUtc) => {
    const { parser } = parserAt(now, noLlm);
    const out = await parser.parse('owner', text);
    if (out.type !== 'capture' || out.item.kind !== 'event')
      throw new Error(`expected event, got ${out.type}`);
    expect(out.item.start.toISOString()).toBe(startUtc);
  });

  it('date-only tasks across DST are anchored at local midnight', async () => {
    const { parser } = parserAt('2026-03-07T17:00:00Z', noLlm);
    const out = await parser.parse('owner', 'bake sale tomorrow');
    if (out.type !== 'capture' || out.item.kind !== 'task') throw new Error('expected task');
    expect(out.item.due?.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(out.item.dueDate).toBe('2026-03-08');
  });

  it('local "today" is used, not the UTC date', async () => {
    // 22:30 EDT on Oct 9 is 02:30 UTC on Oct 10; "tomorrow" is still Oct 10 locally.
    const { parser } = parserAt('2026-10-10T02:30:00Z', noLlm);
    const out = await parser.parse('owner', 'call mom tomorrow');
    if (out.type !== 'capture' || out.item.kind !== 'task') throw new Error('expected task');
    expect(out.item.dueDate).toBe('2026-10-10');
  });
});
