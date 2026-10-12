import {
  AgendaResponseSchema,
  CourseSchema,
  IntegrationStatusSchema,
  ParsePreviewSchema,
  SettingsSchema,
  SuggestionSchema,
  SyncStatusSchema,
  TaskSchema,
  AgendaItemSchema,
  BackupsResponseSchema,
  CalendarEventSchema,
  CanvasConnectionSchema,
  type AcceptSuggestion,
  type CanvasConnect,
  type EventPatch,
  type NewEvent,
  type NewTask,
  type Settings,
  type TaskPatch,
} from '@planner/shared';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(schema: z.ZodType<T>, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  if (res.status === 401) {
    // Session expired: back to the login page, then return here.
    window.location.assign(
      `/login?next=${encodeURIComponent(window.location.pathname + window.location.hash)}`,
    );
    throw new ApiError(401, 'Signed out');
  }
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;
  // 422 from /api/capture still carries a usable body.
  if (!res.ok && res.status !== 422) {
    const msg =
      (json as { message?: string; error?: string } | null)?.message ??
      (json as { error?: string } | null)?.error;
    throw new ApiError(res.status, msg ?? `Request failed (${res.status})`);
  }
  return schema.parse(json);
}

const send = (body: unknown) => ({ body: JSON.stringify(body) });
const TaskEnvelope = z.object({ task: TaskSchema });
const EventEnvelope = z.object({ event: CalendarEventSchema });
const Created = z
  .object({
    kind: z.enum(['task', 'event']),
    title: z.string(),
    source: z.string(),
  })
  .passthrough();

export const api = {
  agenda: (from: string, to: string, includeOverdue = false) =>
    request(
      AgendaResponseSchema,
      `/api/agenda?${new URLSearchParams({ from, to, includeOverdue: String(includeOverdue) })}`,
    ),

  tasks: () => request(z.object({ tasks: z.array(TaskSchema) }), '/api/tasks'),
  createTask: (t: NewTask) => request(TaskEnvelope, '/api/tasks', { method: 'POST', ...send(t) }),
  updateTask: (id: string, patch: TaskPatch) =>
    request(TaskEnvelope, `/api/tasks/${id}`, { method: 'PATCH', ...send(patch) }),
  deleteTask: (id: string) => request(z.null(), `/api/tasks/${id}`, { method: 'DELETE' }),

  /** Planner-only events (Google and Canvas events are read-only). */
  createEvent: (e: NewEvent) =>
    request(EventEnvelope, '/api/events', { method: 'POST', ...send(e) }),
  updateEvent: (id: string, patch: EventPatch) =>
    request(EventEnvelope, `/api/events/${id}`, { method: 'PATCH', ...send(patch) }),
  deleteEvent: (id: string) => request(z.null(), `/api/events/${id}`, { method: 'DELETE' }),

  backups: () => request(BackupsResponseSchema, '/api/backups'),
  runBackup: () =>
    request(z.object({ ok: z.boolean() }).passthrough(), '/api/backups/run', { method: 'POST' }),

  parse: (text: string) =>
    request(z.object({ preview: ParsePreviewSchema }), '/api/parse', {
      method: 'POST',
      ...send({ text, llm: false }),
    }),
  capture: (text: string) =>
    request(
      z.object({ preview: ParsePreviewSchema, created: Created.nullable() }),
      '/api/capture',
      {
        method: 'POST',
        ...send({ text }),
      },
    ),

  suggestions: () =>
    request(z.object({ suggestions: z.array(SuggestionSchema) }), '/api/suggestions'),
  acceptSuggestion: (id: string, body: AcceptSuggestion) =>
    request(z.object({ created: Created }), `/api/suggestions/${id}/accept`, {
      method: 'POST',
      ...send(body),
    }),
  dismissSuggestion: (id: string) =>
    request(z.null(), `/api/suggestions/${id}/dismiss`, { method: 'POST' }),

  settings: () => request(z.object({ settings: SettingsSchema }), '/api/settings'),
  patchSettings: (p: Partial<Settings>) =>
    request(z.object({ settings: SettingsSchema }), '/api/settings', {
      method: 'PATCH',
      ...send(p),
    }),

  integrations: () =>
    request(z.object({ integrations: z.array(IntegrationStatusSchema) }), '/api/status'),
  syncNow: (source: string) =>
    request(z.object({ ok: z.boolean() }).passthrough(), `/api/sync/${source}/run`, {
      method: 'POST',
    }),
  syncStatus: () => request(z.object({ sources: z.array(SyncStatusSchema) }), '/api/sync/status'),
  disconnectGoogle: () => request(z.null(), '/api/sources/google/disconnect', { method: 'POST' }),

  canvasConnection: () => request(CanvasConnectionSchema, '/api/canvas/connection'),
  connectCanvas: (b: CanvasConnect) =>
    request(
      z.object({
        connected: z.boolean(),
        name: z.string().nullable(),
        kind: z.enum(['rest', 'ics']).default('rest'),
      }),
      '/api/canvas/connect',
      { method: 'POST', ...send(b) },
    ),
  disconnectCanvas: () => request(z.null(), '/api/canvas/disconnect', { method: 'POST' }),

  me: () =>
    request(
      z.object({
        authMode: z.enum(['none', 'password', 'cloudflare']),
        writeEventsToGoogle: z.boolean().default(false),
      }),
      '/api/me',
    ),
  courses: (includeGrades: boolean) =>
    request(
      z.object({ courses: z.array(CourseSchema) }),
      `/api/courses?includeGrades=${includeGrades}`,
    ),
  search: (q: string) =>
    request(
      z.object({ items: z.array(AgendaItemSchema) }),
      `/api/search?${new URLSearchParams({ q })}`,
    ),
};
