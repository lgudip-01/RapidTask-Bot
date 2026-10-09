import type { ParsedMessage } from '@planner/shared';
import * as chrono from 'chrono-node';
import {
  addWallDays,
  addWallMinutes,
  nowWall,
  wallCompare,
  wallParts,
  wallWeekday,
} from './local-time';

const pad = (n: number) => String(n).padStart(2, '0');

/** Anything ambiguous, recurring, or editing goes to the model (or a clarifying question). */
const DEFER =
  /\b(every|each|daily|weekly|monthly|biweekly|or|maybe|unless|until|between|sometime|cancel|move|reschedule|delete|remove|change|undo|not|week|weekend|month|end of)\b|[?]/i;
const DEADLINE = /\b(due|by|deadline|submit|turn in|hand in|finish|before)\b/i;
/** Deliverables are tasks even when a time is given ("physics lab report fri 5pm"). */
const DELIVERABLE =
  /\b(report|essay|paper|homework|hw|assignment|pset|problem set|project|application|form|draft|slides|proposal)\b/i;
const LEADING_FILLER = /^(please\s+)?(remind me to|remember to|add|todo:?|task:?|event:?)\s+/i;
/** Date-ish words left in the title mean chrono missed part of the date: let the model decide. */
const LEFTOVER_DATE_WORD =
  /\b(mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday|today|tonight|tomorrow|morning|afternoon|evening|noon|midnight|week|weekend|month|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|am|pm)\b/i;
/** Abbreviations chrono doesn't know. */
const ABBREVIATIONS: [RegExp, string][] = [
  [/\btues\b/gi, 'tuesday'],
  [/\bthurs?\b/gi, 'thursday'],
  [/\bweds?\b/gi, 'wednesday'],
  [/\b(tmrw|tmr|tmw|tmrrw|2moro)\b/gi, 'tomorrow'],
];
const TRAILING_FILLER = /\s+(on|at|by|due|for|this|from|in|@)$/i;

function cleanTitle(s: string) {
  let t = s.replace(/\s+/g, ' ').trim().replace(LEADING_FILLER, '');
  for (let prev = ''; prev !== t;) {
    prev = t;
    t = t
      .replace(TRAILING_FILLER, '')
      .replace(/^(on|at|by|due)\s+/i, '')
      .replace(/[\s,.;:!-]+$/, '')
      .trim();
  }
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

function wallOf(c: chrono.ParsedComponents, withTime: boolean) {
  const date = `${c.get('year')}-${pad(c.get('month')!)}-${pad(c.get('day')!)}`;
  return withTime ? `${date}T${pad(c.get('hour')!)}:${pad(c.get('minute') ?? 0)}` : date;
}

/**
 * Deterministic parse for obvious one-liners ("dentist tues 3pm", "call mom tomorrow").
 * Returns null whenever there is any doubt; the model handles the rest.
 */
export function tryFastParse(input: string, now: Date, timeZone: string): ParsedMessage | null {
  if (input.length > 120 || DEFER.test(input)) return null;
  const text = ABBREVIATIONS.reduce((s, [re, word]) => s.replace(re, word), input);

  // Parse against the local wall clock expressed as a zone-free (UTC) instant, so chrono's
  // components are local wall time and DST is handled later by zonedTimeToUtc.
  const local = nowWall(now, timeZone);
  const p = wallParts(local);
  const ref = new Date(Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm));
  const results = chrono.parse(text, { instant: ref, timezone: 0 }, { forwardDate: true });
  if (results.length !== 1) return null;
  const r = results[0]!;

  const title = cleanTitle(`${text.slice(0, r.index)} ${text.slice(r.index + r.text.length)}`);
  if (title.length < 2 || !/[a-z]/i.test(title) || LEFTOVER_DATE_WORD.test(title)) return null;

  // "fri" on a Friday could mean today or next week.
  if (
    r.start.isCertain('weekday') &&
    !r.start.isCertain('day') &&
    r.start.get('weekday') === wallWeekday(local)
  ) {
    return null;
  }

  const timed = r.start.isCertain('hour');
  // "tomorrow morning" names a time of day without a time: the model decides.
  if (!timed && /\b(morning|afternoon|evening|tonight|night)\b/i.test(r.text)) return null;
  if (timed && !r.start.isCertain('meridiem')) {
    const h = r.start.get('hour')!;
    if (h > 0 && h < 12 && !/\d{1,2}:\d{2}/.test(r.text)) return null; // "at 3" — am or pm?
  }

  const base = {
    title,
    notes: null,
    confidence: 0.9,
    clarifyingQuestion: null,
  };

  // A date range ("conference oct 28-30") is a multi-day all-day event, end exclusive.
  if (!timed && r.end) {
    if (DEADLINE.test(text) || r.end.isCertain('hour')) return null;
    const start = wallOf(r.start, false);
    const end = addWallDays(wallOf(r.end, false), 1);
    if (wallCompare(end, start) <= 0) return null;
    return { kind: 'event', ...base, start, end, due: null, allDay: true };
  }

  if (timed && !DEADLINE.test(text) && !DELIVERABLE.test(text)) {
    const start = wallOf(r.start, true);
    const end = r.end?.isCertain('hour') ? wallOf(r.end, true) : addWallMinutes(start, 60);
    return { kind: 'event', ...base, start, end, due: null, allDay: false };
  }
  return {
    kind: 'task',
    ...base,
    start: null,
    end: null,
    due: wallOf(r.start, timed),
    allDay: !timed,
  };
}
