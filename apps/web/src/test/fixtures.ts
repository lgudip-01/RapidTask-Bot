import {
  DEFAULT_SETTINGS,
  type AgendaItem,
  type CalendarEvent,
  type Suggestion,
  type Task,
} from '@planner/shared';

/** Recorded-shape API payloads for "today" = Fri 2026-10-09 (America/New_York). */
const base = { syncedAt: '2026-10-09T15:00:00.000Z', updatedAt: '2026-10-09T15:00:00.000Z' };

export const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'e1',
  source: 'google_calendar',
  externalId: 'primary/e1',
  title: 'PHYS 201 Lecture',
  start: '2026-10-09T13:00:00.000Z',
  end: '2026-10-09T14:15:00.000Z',
  allDay: false,
  location: 'Hall B',
  description: null,
  calendarName: 'Classes',
  url: null,
  ...base,
  ...over,
});

export const task = (over: Partial<Task>): Task => ({
  id: 't1',
  source: 'canvas',
  externalId: 'assignment-1001',
  title: 'Problem Set 4',
  notes: null,
  due: '2026-10-10T03:59:00.000Z',
  dueAllDay: false,
  status: 'todo',
  statusSetLocally: false,
  priority: null,
  courseOrProject: 'PHYS 201',
  url: null,
  pointsPossible: 20,
  submissionStatus: 'unsubmitted',
  sortOrder: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  completedAt: null,
  ...base,
  ...over,
});

export const agendaToday: AgendaItem[] = [
  {
    kind: 'task',
    at: '2026-10-07T03:59:00.000Z',
    overdue: true,
    item: task({
      id: 't-over',
      title: 'Lab Report 3',
      due: '2026-10-07T03:59:00.000Z',
      submissionStatus: 'missing',
    }),
  },
  {
    kind: 'event',
    at: '2026-10-09T04:00:00.000Z',
    item: event({
      id: 'e-bday',
      title: "Mom's birthday",
      allDay: true,
      start: '2026-10-09T04:00:00.000Z',
      end: '2026-10-10T04:00:00.000Z',
    }),
  },
  { kind: 'event', at: '2026-10-09T13:00:00.000Z', item: event({}) },
  { kind: 'task', at: '2026-10-10T03:59:00.000Z', overdue: false, item: task({}) },
];

export const suggestions: Suggestion[] = [
  {
    id: 's1',
    sourceMessageRef: 'telegram:1',
    proposedTitle: 'Coffee with Priya',
    proposedDue: null,
    confidence: 0.6,
    status: 'pending',
    createdAt: '2026-10-09T15:00:00.000Z',
  },
];

/** fetch stub routing by method + path; unmatched requests fail loudly. */
export function mockApi(
  routes: Record<string, (body: unknown, url: URL) => unknown | Promise<unknown>>,
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler)
      return new Response(JSON.stringify({ error: `no route ${method} ${url.pathname}` }), {
        status: 404,
      });
    const out = await handler(body, url);
    if (out instanceof Response) return out; // e.g. an error status
    return new Response(out === null ? null : JSON.stringify(out), {
      status: out === null ? 204 : 200,
    });
  };
  return Object.assign(fn, { calls });
}

export const defaultRoutes = {
  'GET /api/agenda': () => ({ items: agendaToday }),
  'GET /api/suggestions': () => ({ suggestions }),
  'GET /api/tasks': () => ({
    tasks: agendaToday.flatMap((i) => (i.kind === 'task' ? [i.item] : [])),
  }),
  'GET /api/settings': () => ({ settings: DEFAULT_SETTINGS }),
  'GET /api/status': () => ({ integrations: [] }),
  'GET /api/canvas/connection': () => ({
    connected: false,
    managed: null,
    baseUrl: null,
    canConnect: true,
  }),
};
