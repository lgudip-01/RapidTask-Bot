/**
 * Minimal IANA time-zone helpers built on Intl (no dependencies).
 * Storage is always UTC; these convert between instants and wall-clock time in a zone.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const { type, value } of formatter(timeZone).formatToParts(instant)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS[p.weekday!]!,
  };
}

/** Offset of `timeZone` from UTC at `instant`, in ms (e.g. -4h for EDT). */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const z = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` reads the given time.
 * Nonexistent times (spring-forward gap) resolve forward by the gap; ambiguous times
 * (fall-back overlap) resolve to the earlier instant.
 */
export function zonedTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const before = zoneOffsetMs(new Date(wall - 86_400_000), timeZone);
  const after = zoneOffsetMs(new Date(wall + 86_400_000), timeZone);
  // Try the earlier offset first so ambiguous times pick the first occurrence.
  for (const off of before >= after ? [before, after] : [after, before]) {
    const candidate = wall - off;
    if (zoneOffsetMs(new Date(candidate), timeZone) === off) return new Date(candidate);
  }
  // In a gap: neither offset round-trips; shift forward using the pre-transition offset.
  return new Date(wall - before);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Midnight at the start of a calendar date ("YYYY-MM-DD") in `timeZone`. */
export function startOfDateInZone(date: string, timeZone: string): Date {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`invalid date: ${date}`);
  return zonedTimeToUtc(timeZone, Number(m[1]), Number(m[2]), Number(m[3]));
}

/** The calendar date ("YYYY-MM-DD") of `instant` in `timeZone`. */
export function dateInZone(instant: Date, timeZone: string): string {
  const z = zonedParts(instant, timeZone);
  return `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`;
}

/** Adds whole calendar days to a "YYYY-MM-DD" date. */
export function addDays(date: string, days: number): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`invalid date: ${date}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

/** True if the string carries an explicit UTC offset ("Z" or "±hh:mm"). */
export function hasOffset(dateTime: string): boolean {
  return /(Z|[+-]\d{2}:?\d{2})$/i.test(dateTime);
}

/** Parses "YYYY-MM-DDTHH:mm[:ss]" as wall time in `timeZone` (or as-is if it has an offset). */
export function parseWallDateTime(dateTime: string, timeZone: string): Date {
  if (hasOffset(dateTime)) return new Date(dateTime);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(dateTime);
  if (!m) throw new Error(`invalid date-time: ${dateTime}`);
  return zonedTimeToUtc(
    timeZone,
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  );
}
