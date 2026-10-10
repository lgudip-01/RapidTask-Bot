import type { ResolvedCapture } from '../parser/resolve';

const fmt = (timeZone: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { timeZone, ...opts });

export function formatDate(d: Date, timeZone: string) {
  return fmt(timeZone, { weekday: 'short', month: 'short', day: 'numeric' }).format(d);
}

export function formatTime(d: Date, timeZone: string) {
  // Newer ICU puts a narrow no-break space before AM/PM; SMS-friendlier as a plain space.
  return fmt(timeZone, { hour: 'numeric', minute: '2-digit' })
    .format(d)
    .replace(/\u202f/g, ' ');
}

/** "3:00–4:00 PM", or "11:00 AM–1:00 PM" when the meridiem changes. */
function formatTimeRange(a: Date, b: Date, timeZone: string) {
  const x = formatTime(a, timeZone);
  const y = formatTime(b, timeZone);
  return x.slice(-2) === y.slice(-2) ? `${x.slice(0, -3)}–${y}` : `${x}–${y}`;
}

/** "Tue, Oct 13, 3:00–4:00 PM", "Wed, Oct 28 – Fri, Oct 30 (all day)", "due Sat, Oct 10" */
export function describeWhen(item: ResolvedCapture, timeZone: string): string {
  if (item.kind === 'event') {
    if (item.allDay) {
      const last = new Date(item.end.getTime() - 1);
      const a = formatDate(item.start, timeZone);
      const b = formatDate(last, timeZone);
      return a === b ? `${a} (all day)` : `${a} – ${b} (all day)`;
    }
    const sameDay = formatDate(item.start, timeZone) === formatDate(item.end, timeZone);
    return sameDay
      ? `${formatDate(item.start, timeZone)}, ${formatTimeRange(item.start, item.end, timeZone)}`
      : `${formatDate(item.start, timeZone)} ${formatTime(item.start, timeZone)} – ${formatDate(item.end, timeZone)} ${formatTime(item.end, timeZone)}`;
  }
  if (!item.due) return 'no date';
  return item.dueAllDay
    ? `due ${formatDate(item.due, timeZone)}`
    : `due ${formatDate(item.due, timeZone)}, ${formatTime(item.due, timeZone)}`;
}

export function confirmationText(item: ResolvedCapture, timeZone: string): string {
  const head = item.kind === 'event' ? 'Added event' : 'Added task';
  return `${head}: ${item.title} — ${describeWhen(item, timeZone)}. Reply UNDO to remove.`;
}

/** Strips control characters from model-written text before it is sent anywhere. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
export const plain = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
