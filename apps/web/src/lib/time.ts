import { addDays, dateInZone, startOfDateInZone, zonedParts } from '@planner/shared';

/** All rendering happens in the owner's zone, whatever the browser's zone is. */
export const TZ: string = import.meta.env.VITE_APP_TIMEZONE ?? 'America/New_York';

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(opts: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });
    cache.set(key, f);
  }
  return f;
}
const clean = (s: string) => s.replace(/\u202f/g, ' ');

export const fmtTime = (d: Date | string) =>
  clean(fmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(d)));
export const fmtDay = (d: Date | string) =>
  fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(d));
export const fmtWeekday = (d: Date | string) => fmt({ weekday: 'short' }).format(new Date(d));
export const fmtDayNum = (d: Date | string) => fmt({ day: 'numeric' }).format(new Date(d));
export const fmtLong = (d: Date | string) =>
  fmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(d));
export const fmtMonthRange = (a: Date, b: Date) => {
  const f = fmt({ month: 'short', day: 'numeric' });
  return `${f.format(a)} – ${f.format(b)}`;
};

export function relative(d: Date | string, now = new Date()): string {
  const s = Math.round((new Date(d).getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86_400), 'day');
}

export const todayLocal = (now = new Date()) => dateInZone(now, TZ);
export const dayStart = (date: string) => startOfDateInZone(date, TZ);
export const dayRange = (date: string) => ({
  from: dayStart(date),
  to: dayStart(addDays(date, 1)),
});

/** Monday of the week containing `date`. */
export function weekStart(date: string) {
  const dow = zonedParts(dayStart(date), TZ).weekday; // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

export const minutesIntoDay = (d: Date) => {
  const p = zonedParts(d, TZ);
  return p.hour * 60 + p.minute;
};

export { addDays };
