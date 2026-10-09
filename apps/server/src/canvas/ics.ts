import { parseWallDateTime, startOfDateInZone } from '@planner/shared';

/** A VEVENT with the properties we use. Dates are resolved to instants or calendar dates. */
export interface IcsEvent {
  uid: string;
  summary: string;
  start: { date: string } | { instant: Date };
  end: { date: string } | { instant: Date } | null;
  url: string | null;
  lastModified: Date | null;
}

const unescapeText = (v: string) =>
  v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

/** Unfolds RFC 5545 continuation lines. */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length)
      out[out.length - 1] += line.slice(1);
    else if (line) out.push(line);
  }
  return out;
}

interface Prop {
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): [string, Prop] | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const [name, ...paramParts] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return [name!.toUpperCase(), { params, value: line.slice(colon + 1) }];
}

function parseDate(p: Prop, floatingZone: string): { date: string } | { instant: Date } {
  const v = p.value.trim();
  if (p.params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) throw new Error('unsupported DTSTART/DTEND format');
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  if (m[7] === 'Z') return { instant: new Date(`${iso}Z`) };
  return { instant: parseWallDateTime(iso, p.params.TZID ?? floatingZone) };
}

/** Minimal iCalendar reader for Canvas feeds: VEVENTs with UID/SUMMARY/DTSTART/DTEND/URL. */
export function parseIcs(text: string, floatingZone: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let cur: Map<string, Prop> | null = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') {
      cur = new Map();
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur) {
        const uid = cur.get('UID')?.value;
        const dtstart = cur.get('DTSTART');
        if (uid && dtstart) {
          const dtend = cur.get('DTEND');
          const lm = cur.get('LAST-MODIFIED') ?? cur.get('DTSTAMP');
          events.push({
            uid,
            summary: unescapeText(cur.get('SUMMARY')?.value ?? '').trim(),
            start: parseDate(dtstart, floatingZone),
            end: dtend ? parseDate(dtend, floatingZone) : null,
            url: cur.get('URL')?.value ?? null,
            lastModified: lm
              ? ((parseDate(lm, 'UTC') as { instant?: Date }).instant ?? null)
              : null,
          });
        }
      }
      cur = null;
      continue;
    }
    if (cur) {
      const parsed = parseLine(line);
      if (parsed && !cur.has(parsed[0])) cur.set(parsed[0], parsed[1]);
    }
  }
  return events;
}

/** Resolves an ICS start/end to an instant, anchoring dates at midnight in `zone`. */
export function icsInstant(v: { date: string } | { instant: Date }, zone: string): Date {
  return 'date' in v ? startOfDateInZone(v.date, zone) : v.instant;
}
