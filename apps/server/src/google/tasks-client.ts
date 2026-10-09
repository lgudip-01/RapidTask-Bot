import { GoogleApiError } from './calendar-client';
import type { AccessTokenProvider, FetchFn } from './oauth';

export const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';
export const DEFAULT_TASK_LIST = '@default';

export interface GTask {
  id: string;
  title?: string;
  notes?: string;
  status?: 'needsAction' | 'completed';
  /** RFC 3339; Google Tasks keeps only the date part. */
  due?: string;
  updated?: string;
  completed?: string;
  webViewLink?: string;
}

/** Minimal Google Tasks write client (create / complete / delete) for inbound capture. */
export class GoogleTasksClient {
  constructor(
    private readonly auth: AccessTokenProvider,
    private readonly fetchFn: FetchFn = fetch,
    private readonly base = TASKS_API,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const res = await this.fetchFn(new URL(this.base + path), {
      method,
      headers: {
        authorization: `Bearer ${await this.auth.accessToken()}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !retried) {
      this.auth.invalidate();
      return this.call(method, path, body, true);
    }
    if (!res.ok)
      throw new GoogleApiError(res.status, undefined, `Google Tasks ${method} ${res.status}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private static path(list: string, id?: string) {
    const base = `/lists/${encodeURIComponent(list)}/tasks`;
    return id ? `${base}/${encodeURIComponent(id)}` : base;
  }

  /** `dueDate` is a local calendar date ("YYYY-MM-DD"). */
  insert(
    task: { title: string; notes?: string | null; dueDate?: string | null },
    list = DEFAULT_TASK_LIST,
  ) {
    return this.call<GTask>('POST', GoogleTasksClient.path(list), {
      title: task.title,
      ...(task.notes && { notes: task.notes }),
      ...(task.dueDate && { due: `${task.dueDate}T00:00:00.000Z` }),
    });
  }

  complete(id: string, list = DEFAULT_TASK_LIST) {
    return this.call<GTask>('PATCH', GoogleTasksClient.path(list, id), { status: 'completed' });
  }

  async delete(id: string, list = DEFAULT_TASK_LIST) {
    await this.call<void>('DELETE', GoogleTasksClient.path(list, id));
  }
}

export const googleTaskExternalId = (list: string, id: string) => `${list}/${id}`;
export function splitGoogleTaskExternalId(externalId: string) {
  const i = externalId.lastIndexOf('/');
  return { list: externalId.slice(0, i), id: externalId.slice(i + 1) };
}
