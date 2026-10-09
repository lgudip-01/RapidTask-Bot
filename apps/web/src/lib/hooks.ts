import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/** Global single-key shortcuts, ignored while typing or with modifiers held. */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true) {
  const ref = useRef(map);
  useEffect(() => {
    ref.current = map;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const fn = ref.current[e.key];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

export function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Re-renders every `ms` (for "now" lines and relative times). */
export function useNow(ms = 60_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Hash routes: #/today, #/week, #/tasks, #/suggestions, #/settings. */
export const VIEWS = ['today', 'week', 'tasks', 'suggestions', 'settings'] as const;
export type View = (typeof VIEWS)[number];

const readView = (): View => {
  const v = window.location.hash.replace(/^#\/?/, '');
  return (VIEWS as readonly string[]).includes(v) ? (v as View) : 'today';
};

export function useView(): [View, (v: View) => void] {
  const view = useSyncExternalStore((l) => {
    window.addEventListener('hashchange', l);
    return () => window.removeEventListener('hashchange', l);
  }, readView);
  return [view, (v) => void (window.location.hash = `/${v}`)];
}

/** Theme preference stored per browser (a convenience, so storage failures are ignored). */
export type ThemePref = 'system' | 'light' | 'dark';
const THEME_KEY = 'planner.theme';
export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}
export function applyTheme(pref: ThemePref) {
  const dark =
    pref === 'dark' ||
    (pref === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // ignore
  }
}
