import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@planner/shared';
import { App } from './App';
import { agendaToday, defaultRoutes, event, mockApi, task } from './test/fixtures';

function renderApp(routes: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({ ...defaultRoutes, ...routes });
  vi.stubGlobal('fetch', api);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
  return api;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-09T16:00:00.000Z')); // Fri noon in New York
});

describe('Today', () => {
  it('shows overdue, all-day, and timeline items plus the suggestions tray', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Friday, October 9' })).toBeTruthy();
    const overdue = await screen.findByText('Lab Report 3');
    expect(overdue).toBeTruthy();
    expect(screen.getByText(/overdue · Tue, Oct 6, 11:59 PM/)).toBeTruthy();
    expect(screen.getByText("Mom's birthday")).toBeTruthy();
    expect(screen.getByText('PHYS 201 Lecture')).toBeTruthy();
    expect(screen.getByText('missing')).toBeTruthy();
    expect(screen.getAllByText('Coffee with Priya').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/Now, 12:00 PM/)).toBeTruthy();
  });

  it('shows an error state with retry when the API fails', async () => {
    renderApp({ 'GET /api/agenda': () => Promise.reject(new Error('boom')) });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('checks a task off optimistically before the server answers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const api = renderApp({
      'PATCH /api/tasks/t1': async (body) => {
        await gate;
        return { task: task({ ...(body as object), completedAt: '2026-10-09T16:00:00.000Z' }) };
      },
    });
    const box = await screen.findByRole('checkbox', { name: 'Mark done: Problem Set 4' });
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(box);
    // Updated immediately, while the PATCH is still pending.
    expect(
      screen
        .getByRole('checkbox', { name: 'Mark not done: Problem Set 4' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'done' });
    await act(async () => release());
  });
});

describe('keyboard shortcuts', () => {
  it('"/" opens search, Escape closes it, "n" opens quick add, "t" returns to Today', async () => {
    renderApp({ 'GET /api/search': () => ({ items: [] }) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await screen.findByText('PHYS 201 Lecture');

    await user.keyboard('/');
    expect(await screen.findByRole('dialog', { name: 'Search' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull());

    await user.keyboard('n');
    const dialog = await screen.findByRole('dialog', { name: 'New task or event' });
    expect(within(dialog).getByLabelText(/add a task or event/i)).toBeTruthy();
    await user.keyboard('{Escape}');

    window.location.hash = '#/settings';
    await screen.findByRole('heading', { name: 'Settings' });
    await user.keyboard('t');
    expect(await screen.findByRole('heading', { name: 'Friday, October 9' })).toBeTruthy();
  });

  it('ignores shortcuts while typing', async () => {
    renderApp({
      'POST /api/parse': () => ({
        preview: { type: 'error', reason: 'llm_disabled', message: 'x' },
      }),
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    window.location.hash = '#/tasks';
    const input = await screen.findByLabelText(/add a task or event/i);
    await user.type(input, 'test/n');
    expect((input as HTMLInputElement).value).toBe('test/n');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('quick add', () => {
  it('previews the parsed date while typing and adds on Enter', async () => {
    vi.useRealTimers();
    const api = renderApp({
      'POST /api/parse': () => ({
        preview: {
          type: 'capture',
          kind: 'task',
          title: 'Physics lab report',
          start: null,
          end: null,
          due: '2026-10-16T21:00:00.000Z',
          allDay: false,
          via: 'fast',
          summary: 'due Fri, Oct 16, 5:00 PM',
        },
      }),
      'POST /api/capture': () => ({
        preview: {
          type: 'capture',
          kind: 'task',
          title: 'Physics lab report',
          start: null,
          end: null,
          due: '2026-10-16T21:00:00.000Z',
          allDay: false,
          via: 'fast',
          summary: 'due Fri, Oct 16, 5:00 PM',
        },
        created: { kind: 'task', title: 'Physics lab report', source: 'local' },
      }),
    });
    window.location.hash = '#/tasks';
    const input = await screen.findByLabelText(/add a task or event/i);
    await userEvent.type(input, 'physics lab report fri 5pm');
    expect(await screen.findByText(/due Fri, Oct 16, 5:00 PM/)).toBeTruthy();
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/capture')).toBe(true),
    );
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
    expect(await screen.findByText('Added task: Physics lab report')).toBeTruthy();
  });
});

describe('Settings', () => {
  it('shows Google write-back as off and impossible to turn on', async () => {
    const api = renderApp({
      'GET /api/me': () => ({ authMode: 'none', writeEventsToGoogle: true }),
    });
    window.location.hash = '#/settings';
    const toggle = await screen.findByRole('switch', {
      name: 'Copy texted events to Google Calendar',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText(/WRITE_EVENTS_TO_GOOGLE=true, which is ignored/)).toBeTruthy();
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('Settings: notifications', () => {
  it('shows the digest time and saves a change', async () => {
    const api = renderApp({
      'PATCH /api/settings': (body) => ({ settings: { ...DEFAULT_SETTINGS, ...(body as object) } }),
    });
    window.location.hash = '#/settings';
    const time = (await screen.findAllByLabelText('Send at'))[0] as HTMLInputElement;
    expect(time.value).toBe('07:30');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('switch', { name: 'Event reminders' }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === 'PATCH')).toEqual([
        { method: 'PATCH', path: '/api/settings', body: { eventReminders: false } },
      ]),
    );
  });
});

/** Minimal EventSource stand-in: tests push server events by hand. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
  close() {}
}

const localTask = task({
  id: 't-local',
  source: 'local',
  externalId: 't-local',
  title: 'Pay rent',
  due: '2026-10-09T04:00:00.000Z',
  dueAllDay: true,
  courseOrProject: null,
  pointsPossible: null,
  submissionStatus: null,
});

describe('item details', () => {
  const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

  it('Google events open read-only: no inputs, no save, no delete', async () => {
    renderApp();
    await user().click(await screen.findByRole('button', { name: 'Details: PHYS 201 Lecture' }));
    const dialog = await screen.findByRole('dialog', { name: 'Event details' });
    expect(within(dialog).getByText(/Read-only\./)).toBeTruthy();
    expect(within(dialog).getByText(/comes from Google Calendar/)).toBeTruthy();
    expect(within(dialog).queryAllByRole('textbox')).toEqual([]);
    expect(within(dialog).queryByRole('button', { name: /delete|save/i })).toBeNull();
  });

  it('Canvas assignments open read-only; the check-off is saved only in Planner', async () => {
    const api = renderApp({
      'PATCH /api/tasks/t1': (body) => ({ task: task({ ...(body as object) }) }),
    });
    await user().click(await screen.findByRole('button', { name: 'Details: Problem Set 4' }));
    const dialog = await screen.findByRole('dialog', { name: 'Task details' });
    expect(within(dialog).getByText(/comes from Canvas/)).toBeTruthy();
    expect(within(dialog).queryAllByRole('textbox')).toEqual([]);
    expect(within(dialog).queryByRole('button', { name: /delete|save/i })).toBeNull();
    await user().click(
      within(dialog).getByRole('checkbox', { name: 'Mark done in Planner: Problem Set 4' }),
    );
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === 'PATCH')).toEqual([
        { method: 'PATCH', path: '/api/tasks/t1', body: { status: 'done' } },
      ]),
    );
  });

  it('Planner tasks can be edited and deleted', async () => {
    const api = renderApp({
      'GET /api/agenda': () => ({
        items: [
          ...agendaToday,
          { kind: 'task', at: localTask.due!, overdue: false, item: localTask },
        ],
      }),
      'PATCH /api/tasks/t-local': (body) => ({ task: { ...localTask, ...(body as object) } }),
      'DELETE /api/tasks/t-local': () => null,
    });
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Details: Pay rent' }));
    let dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    expect(within(dialog).getByText(/Saved only in Planner/)).toBeTruthy();
    const title = within(dialog).getByLabelText('Title');
    await u.clear(title);
    await u.type(title, 'Pay rent (October)');
    await u.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
        title: 'Pay rent (October)',
        due: '2026-10-09T04:00:00.000Z',
        dueAllDay: true,
        status: 'todo',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit task' })).toBeNull());

    await u.click(await screen.findByRole('button', { name: 'Details: Pay rent' }));
    dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await u.click(within(dialog).getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
        '/api/tasks/t-local',
      ]),
    );
  });

  it('the event form creates a Planner event with DST-correct times', async () => {
    const api = renderApp({
      'POST /api/events': (body) => ({
        event: event({ id: 'new', source: 'local', title: (body as { title: string }).title }),
      }),
    });
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'New task or event (n)' }));
    await u.click(await screen.findByRole('button', { name: 'New event' }));
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    await u.type(within(dialog).getByLabelText('Title'), 'Dentist');
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-11-02' } });
    fireEvent.change(within(dialog).getByLabelText('Starts'), { target: { value: '09:00' } });
    fireEvent.change(within(dialog).getByLabelText('Ends'), { target: { value: '10:30' } });
    await u.click(within(dialog).getByRole('button', { name: 'Add event' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/events')?.body).toEqual({
        title: 'Dentist',
        // Mon Nov 2 is after the DST change: 09:00 EST = 14:00Z.
        when: {
          allDay: false,
          start: '2026-11-02T14:00:00.000Z',
          end: '2026-11-02T15:30:00.000Z',
        },
        location: null,
        description: null,
      }),
    );
  });
});

describe('live updates', () => {
  it('shows a texted task without a reload when the server announces a change', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    let items = agendaToday;
    renderApp({ 'GET /api/agenda': () => ({ items }) });
    await screen.findByText('Problem Set 4');
    act(() => FakeEventSource.last!.onopen?.());
    expect(await screen.findByText('Live')).toBeTruthy();
    expect(FakeEventSource.last!.url).toBe('/api/stream');

    items = [
      ...agendaToday,
      {
        kind: 'task',
        at: '2026-10-09T21:00:00.000Z',
        overdue: false,
        item: {
          ...localTask,
          id: 't-texted',
          title: 'Call the landlord',
          due: '2026-10-09T21:00:00.000Z',
          dueAllDay: false,
        },
      },
    ];
    expect(screen.queryByText('Call the landlord')).toBeNull();
    act(() => FakeEventSource.last!.emit('change', JSON.stringify({ seq: 1, topic: 'items' })));
    expect(await screen.findByText('Call the landlord')).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe('Settings: backups', () => {
  it('shows the last backup and runs one on request', async () => {
    const api = renderApp({
      'GET /api/backups': () => ({
        status: {
          health: 'ok',
          lastSuccessAt: '2026-10-09T07:00:12.000Z',
          lastAttemptAt: '2026-10-09T07:00:00.000Z',
          lastError: null,
          lastFile: 'planner-20261009-070000.db',
          lastSizeBytes: 245_760,
          nextScheduledAt: '2026-10-10T07:00:00.000Z',
          running: false,
          enabled: true,
          keep: 14,
        },
        recent: [],
      }),
      'POST /api/backups/run': () => ({ ok: true, error: null, file: 'planner-x.db' }),
    });
    window.location.hash = '#/settings';
    const last = await screen.findByTestId('last-backup');
    expect(last.textContent).toBe('9 hours ago (Fri, Oct 9, 3:00 AM) · 240 KB');
    expect(screen.getByText('healthy')).toBeTruthy();
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(screen.getByRole('button', { name: 'Back up now' }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
        '/api/backups/run',
      ]),
    );
  });
});
