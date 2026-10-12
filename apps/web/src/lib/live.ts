import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { keys } from './queries';

/** Which cached queries each server change topic makes stale. */
const STALE: Record<string, QueryKey[]> = {
  items: [['agenda'], keys.tasks],
  suggestions: [keys.suggestions, ['agenda'], keys.tasks],
  sync: [['agenda'], keys.tasks, keys.integrations, ['courses']],
  backup: [keys.backups],
  settings: [keys.settings],
};

const POLL_MS = 15_000;

export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'polling';

/**
 * Keeps every open view current. The server pushes a content-free "something changed" event over
 * Server-Sent Events (e.g. when the Telegram bot adds a task); the matching queries refetch.
 * Without EventSource, or when the server declines streaming (204: serverless hosting), it polls
 * instead. After a dropped connection, everything is refetched.
 */
export function useLiveUpdates(): LiveState {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>(() =>
    typeof EventSource === 'undefined' ? 'polling' : 'connecting',
  );

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      const id = setInterval(() => void qc.invalidateQueries(), POLL_MS);
      return () => clearInterval(id);
    }
    const es = new EventSource('/api/stream');
    let dropped = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    es.addEventListener('change', (e) => {
      let topic = 'items';
      try {
        topic = (JSON.parse((e as MessageEvent<string>).data) as { topic?: string }).topic ?? topic;
      } catch {
        // malformed event: refresh items
      }
      for (const queryKey of STALE[topic] ?? STALE.items!) void qc.invalidateQueries({ queryKey });
    });
    es.onopen = () => {
      setState('live');
      if (dropped) void qc.invalidateQueries();
      dropped = false;
    };
    es.onerror = () => {
      // CLOSED means the server declined (no auto-reconnect): fall back to polling for good.
      if (es.readyState === EventSource.CLOSED) {
        setState('polling');
        poll ??= setInterval(() => void qc.invalidateQueries(), POLL_MS);
        return;
      }
      dropped = true;
      setState('reconnecting');
    };
    return () => {
      es.close();
      if (poll) clearInterval(poll);
    };
  }, [qc]);

  return state;
}
