import type {
  AgendaResponse,
  EventPatch,
  NewEvent,
  NewTask,
  Settings,
  Task,
  TaskPatch,
} from '@planner/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { toast } from './toast';

export const keys = {
  agenda: (from: string, to: string, overdue: boolean) => ['agenda', from, to, overdue] as const,
  tasks: ['tasks'] as const,
  suggestions: ['suggestions'] as const,
  settings: ['settings'] as const,
  integrations: ['integrations'] as const,
  courses: (grades: boolean) => ['courses', grades] as const,
  backups: ['backups'] as const,
};

/** Agenda and task lists, after any change to items. */
const refreshItems = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: keys.tasks });
  void qc.invalidateQueries({ queryKey: ['agenda'] });
};

export const useAgenda = (from: Date, to: Date, includeOverdue = false) =>
  useQuery({
    queryKey: keys.agenda(from.toISOString(), to.toISOString(), includeOverdue),
    queryFn: () => api.agenda(from.toISOString(), to.toISOString(), includeOverdue),
    placeholderData: keepPreviousData,
  });

export const useTasks = () =>
  useQuery({ queryKey: keys.tasks, queryFn: async () => (await api.tasks()).tasks });
export const useSuggestions = () =>
  useQuery({
    queryKey: keys.suggestions,
    queryFn: async () => (await api.suggestions()).suggestions,
  });
export const useSettings = () =>
  useQuery({ queryKey: keys.settings, queryFn: async () => (await api.settings()).settings });
export const useIntegrations = () =>
  useQuery({
    queryKey: keys.integrations,
    queryFn: async () => (await api.integrations()).integrations,
    refetchInterval: 30_000,
  });
export const useCourses = (grades: boolean) =>
  useQuery({
    queryKey: keys.courses(grades),
    queryFn: async () => (await api.courses(grades)).courses,
  });

/** Applies `patch` to a task in every cached list (tasks + agenda). */
function patchCaches(qc: ReturnType<typeof useQueryClient>, id: string, patch: Partial<Task>) {
  qc.setQueryData<Task[]>(keys.tasks, (old) =>
    old?.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  );
  qc.setQueriesData<AgendaResponse>({ queryKey: ['agenda'] }, (old) =>
    old
      ? {
          items: old.items.map((i) =>
            i.kind === 'task' && i.item.id === id ? { ...i, item: { ...i.item, ...patch } } : i,
          ),
        }
      : old,
  );
}

/** Optimistic task update: the UI changes immediately and rolls back if the server refuses. */
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TaskPatch }) => api.updateTask(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.tasks });
      await qc.cancelQueries({ queryKey: ['agenda'] });
      const snapshot = {
        tasks: qc.getQueryData(keys.tasks),
        agenda: qc.getQueriesData({ queryKey: ['agenda'] }),
      };
      const optimistic: Partial<Task> = { ...(patch as Partial<Task>) };
      if (patch.status)
        optimistic.completedAt = patch.status === 'done' ? new Date().toISOString() : null;
      patchCaches(qc, id, optimistic);
      return snapshot;
    },
    onError: (err, _vars, snap) => {
      if (snap) {
        qc.setQueryData(keys.tasks, snap.tasks);
        for (const [k, v] of snap.agenda) qc.setQueryData(k, v);
      }
      toast.error(err instanceof Error ? err.message : 'Update failed');
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.tasks });
      void qc.invalidateQueries({ queryKey: ['agenda'] });
    },
  });
}

export function useCapture() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => api.capture(text),
    onSuccess: (res) => {
      if (res.created) {
        toast.success(
          `Added ${res.created.kind === 'event' ? 'event' : 'task'}: ${res.created.title}`,
        );
        void qc.invalidateQueries({ queryKey: keys.tasks });
        void qc.invalidateQueries({ queryKey: ['agenda'] });
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not add'),
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (t: NewTask) => api.createTask(t),
    onSuccess: (res) => toast.success(`Added task: ${res.task.title}`),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not add'),
    onSettled: () => refreshItems(qc),
  });
}

export function useCreateEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (e: NewEvent) => api.createEvent(e),
    onSuccess: (res) => toast.success(`Added event: ${res.event.title}`),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not add'),
    onSettled: () => refreshItems(qc),
  });
}

export function useUpdateEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: EventPatch }) => api.updateEvent(id, patch),
    onSuccess: () => toast.success('Event saved'),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save'),
    onSettled: () => refreshItems(qc),
  });
}

export function useDeleteEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteEvent(id),
    onSuccess: () => toast.success('Event deleted'),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Delete failed'),
    onSettled: () => refreshItems(qc),
  });
}

export const useBackups = () =>
  useQuery({ queryKey: keys.backups, queryFn: () => api.backups(), refetchInterval: 60_000 });

export function useRunBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.runBackup(),
    onSuccess: () => toast.success('Backup complete'),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Backup failed'),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.backups }),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: keys.tasks });
      const prev = qc.getQueryData<Task[]>(keys.tasks);
      qc.setQueryData<Task[]>(keys.tasks, (old) => old?.filter((t) => t.id !== id));
      return prev;
    },
    onError: (err, _id, prev) => {
      qc.setQueryData(keys.tasks, prev);
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.tasks });
      void qc.invalidateQueries({ queryKey: ['agenda'] });
    },
  });
}

export function useSuggestionActions() {
  const qc = useQueryClient();
  const removeLocally = async (id: string) => {
    await qc.cancelQueries({ queryKey: keys.suggestions });
    const prev = qc.getQueryData(keys.suggestions);
    qc.setQueryData<{ id: string }[]>(keys.suggestions, (old) => old?.filter((s) => s.id !== id));
    return prev;
  };
  const settle = () => {
    void qc.invalidateQueries({ queryKey: keys.suggestions });
    void qc.invalidateQueries({ queryKey: keys.tasks });
    void qc.invalidateQueries({ queryKey: ['agenda'] });
  };
  const accept = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.acceptSuggestion>[1] }) =>
      api.acceptSuggestion(id, body),
    onMutate: ({ id }) => removeLocally(id),
    onSuccess: (res) => toast.success(`Added: ${res.created.title}`),
    onError: (err, _v, prev) => {
      qc.setQueryData(keys.suggestions, prev);
      toast.error(err instanceof Error ? err.message : 'Could not accept');
    },
    onSettled: settle,
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api.dismissSuggestion(id),
    onMutate: (id) => removeLocally(id),
    onError: (err, _v, prev) => {
      qc.setQueryData(keys.suggestions, prev);
      toast.error(err instanceof Error ? err.message : 'Could not dismiss');
    },
    onSettled: settle,
  });
  return { accept, dismiss };
}

export function usePatchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Partial<Settings>) => api.patchSettings(p),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: keys.settings });
      const prev = qc.getQueryData<Settings>(keys.settings);
      if (prev) qc.setQueryData(keys.settings, { ...prev, ...p });
      return prev;
    },
    onError: (err, _p, prev) => {
      qc.setQueryData(keys.settings, prev);
      toast.error(err instanceof Error ? err.message : 'Could not save setting');
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.settings }),
  });
}

export function useSyncNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (source: string) => api.syncNow(source),
    onSuccess: (res) =>
      res.ok ? toast.success('Synced') : toast.error('Sync failed — see details'),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Sync failed'),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.integrations });
      void qc.invalidateQueries({ queryKey: ['agenda'] });
      void qc.invalidateQueries({ queryKey: keys.tasks });
    },
  });
}

export function useDisconnectGoogle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.disconnectGoogle(),
    onSuccess: () => toast.success('Google disconnected'),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not disconnect'),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.integrations }),
  });
}
