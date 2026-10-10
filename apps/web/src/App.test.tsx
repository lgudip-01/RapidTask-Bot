import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { defaultRoutes, mockApi, task } from './test/fixtures';

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
        created: { kind: 'task', title: 'Physics lab report', source: 'local', fallbackNote: null },
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
