import { zonedParts, zonedTimeToUtc } from '@planner/shared';

/**
 * Wall-clock arithmetic on "YYYY-MM-DD" / "YYYY-MM-DDTHH:mm" strings. Uses UTC Date math as a
 * zone-free calendar, then converts to an instant with the DST-aware zonedTimeToUtc.
 */
const pad = (n: number) => String(n).padStart(2, '0');

export function wallParts(s: string) {
  const [date, time] = s.split('T');
  const [y, m, d] = date!.split('-').map(Number);
  const [hh, mm] = time ? time.split(':').map(Number) : [0, 0];
  return { y: y!, m: m!, d: d!, hh: hh!, mm: mm! };
}

function fromFloating(ms: number, withTime: boolean) {
  const dt = new Date(ms);
  const date = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  return withTime ? `${date}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}` : date;
}

function toFloating(s: string) {
  const p = wallParts(s);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
}

export function addWallMinutes(s: string, minutes: number) {
  return fromFloating(toFloating(s) + minutes * 60_000, s.includes('T'));
}

export function addWallDays(s: string, days: number) {
  return fromFloating(toFloating(s) + days * 86_400_000, s.includes('T'));
}

/** Compares two wall strings of the same shape. */
export const wallCompare = (a: string, b: string) => toFloating(a) - toFloating(b);

export function wallToInstant(s: string, timeZone: string): Date {
  const p = wallParts(s);
  return zonedTimeToUtc(timeZone, p.y, p.m, p.d, p.hh, p.mm);
}

/** The current wall-clock time in `timeZone` as "YYYY-MM-DDTHH:mm". */
export function nowWall(now: Date, timeZone: string) {
  const z = zonedParts(now, timeZone);
  return `${z.year}-${pad(z.month)}-${pad(z.day)}T${pad(z.hour)}:${pad(z.minute)}`;
}

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export function wallWeekday(s: string) {
  const p = wallParts(s);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}
