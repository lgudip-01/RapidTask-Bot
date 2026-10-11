import type { CalendarEvent, Task } from '@planner/shared';
import { useSyncExternalStore } from 'react';

/** What the item dialog shows: an existing item, or a blank form for a new Planner item. */
export type ItemTarget =
  | { kind: 'task'; task: Task }
  | { kind: 'event'; event: CalendarEvent }
  | { kind: 'new-task' }
  | { kind: 'new-event' };

let current: ItemTarget | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openItem(target: ItemTarget) {
  current = target;
  emit();
}

export function closeItem() {
  current = null;
  emit();
}

export const useItemTarget = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
