import {
  CalendarDays,
  Inbox,
  ListTodo,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  Sunrise,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState } from 'react';
import { Dialog } from './components/Dialog';
import { ItemDialog } from './components/ItemDialog';
import { QuickAdd } from './components/QuickAdd';
import { SearchDialog } from './components/SearchDialog';
import { Toaster } from './components/Toaster';
import { Button, cx, Kbd } from './components/ui';
import { applyTheme, readThemePref, useHotkeys, useView, type View } from './lib/hooks';
import { openItem } from './lib/itemDialog';
import { useLiveUpdates } from './lib/live';
import { useSuggestions } from './lib/queries';
import { SettingsView } from './views/SettingsView';
import { SuggestionsView } from './views/SuggestionsView';
import { TasksView } from './views/TasksView';
import { TodayView } from './views/TodayView';
import { WeekView } from './views/WeekView';

const NAV: { id: View; label: string; icon: typeof Sunrise }[] = [
  { id: 'today', label: 'Today', icon: Sunrise },
  { id: 'week', label: 'Week', icon: CalendarDays },
  { id: 'tasks', label: 'Tasks', icon: ListTodo },
  { id: 'suggestions', label: 'Suggestions', icon: Inbox },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function App() {
  const [view, setView] = useView();
  const [adding, setAdding] = useState(false);
  const [searching, setSearching] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  const suggestions = useSuggestions();
  const quickAddRef = useRef<HTMLInputElement>(null);
  const pending = suggestions.data?.length ?? 0;
  const live = useLiveUpdates();

  useHotkeys(
    {
      n: () => (view === 'tasks' ? quickAddRef.current?.focus() : setAdding(true)),
      t: () => setView('today'),
      '/': () => setSearching(true),
    },
    !adding && !searching,
  );

  const toggleTheme = () => {
    const next = dark ? 'light' : 'dark';
    applyTheme(
      readThemePref() === 'system' &&
        (next === 'dark') === window.matchMedia?.('(prefers-color-scheme: dark)').matches
        ? 'system'
        : next,
    );
    setDark(!dark);
  };

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 md:px-6">
          <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <motion.span
              aria-hidden
              className="grid size-6 place-items-center rounded-md bg-accent text-[11px] font-bold text-white"
              whileHover={{ rotate: -8, scale: 1.05 }}
            >
              P
            </motion.span>
            <span className="hidden sm:inline">Planner</span>
          </span>
          <nav aria-label="Views" className="flex flex-1 items-center gap-0.5 overflow-x-auto">
            {NAV.map(({ id, label, icon: Icon }) => (
              <a
                key={id}
                href={`#/${id}`}
                aria-current={view === id ? 'page' : undefined}
                className={cx(
                  'relative flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm transition-colors',
                  view === id ? 'text-ink' : 'text-muted hover:text-ink',
                )}
              >
                {view === id && (
                  <motion.span
                    layoutId="nav-pill"
                    className="absolute inset-0 rounded-lg bg-surface-2"
                    transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                  />
                )}
                <Icon className="relative size-4" aria-hidden />
                <span className="relative hidden md:inline">{label}</span>
                {id === 'suggestions' && pending > 0 && (
                  <motion.span
                    key={pending}
                    initial={{ scale: 0.4 }}
                    animate={{ scale: 1 }}
                    className="relative rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-white"
                  >
                    {pending}
                  </motion.span>
                )}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-1">
            <span
              role="status"
              title={
                live === 'live'
                  ? 'Live: new items appear automatically'
                  : live === 'polling'
                    ? 'Refreshing every 30 seconds'
                    : 'Reconnecting…'
              }
              className="mr-1 inline-flex items-center gap-1.5 text-[11px] text-muted"
            >
              <motion.span
                aria-hidden
                className={cx(
                  'size-2 rounded-full',
                  live === 'live' ? 'bg-ok' : live === 'polling' ? 'bg-muted' : 'bg-warn',
                )}
                animate={live === 'live' ? { opacity: [1, 0.4, 1] } : { opacity: 1 }}
                transition={live === 'live' ? { duration: 2.4, repeat: Infinity } : {}}
              />
              <span className="sr-only lg:not-sr-only">
                {live === 'live' ? 'Live' : live === 'polling' ? 'Auto-refresh' : 'Reconnecting'}
              </span>
            </span>
            <button
              onClick={() => setSearching(true)}
              className="flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm text-muted hover:bg-surface-2 hover:text-ink"
              aria-label="Search (/)"
            >
              <Search className="size-4" />{' '}
              <span className="hidden lg:inline">
                <Kbd>/</Kbd>
              </span>
            </button>
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={() => setAdding(true)}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-white"
              aria-label="New task or event (n)"
            >
              <Plus className="size-4" /> <span className="hidden sm:inline">New</span>
            </motion.button>
            <button
              onClick={toggleTheme}
              className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
              aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={dark ? 'moon' : 'sun'}
                  initial={{ rotate: -90, opacity: 0 }}
                  animate={{ rotate: 0, opacity: 1 }}
                  exit={{ rotate: 90, opacity: 0 }}
                  transition={{ duration: 0.18 }}
                >
                  {dark ? <Moon className="size-4" /> : <Sun className="size-4" />}
                </motion.span>
              </AnimatePresence>
            </button>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-6xl px-4 py-6 md:px-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            {view === 'today' && <TodayView />}
            {view === 'week' && <WeekView />}
            {view === 'tasks' && <TasksView ref={quickAddRef} />}
            {view === 'suggestions' && <SuggestionsView />}
            {view === 'settings' && <SettingsView />}
          </motion.div>
        </AnimatePresence>
      </main>

      <Dialog open={adding} onClose={() => setAdding(false)} label="New task or event">
        <div className="p-4">
          <p className="mb-2 text-xs text-muted">
            Type naturally: anything with a time becomes a Planner event, deadlines become Planner
            tasks. Saved only in Planner; nothing is sent to Google.
          </p>
          <QuickAdd autoFocus onAdded={() => setAdding(false)} />
          <div className="mt-3 flex items-center gap-2 text-xs text-muted">
            Or fill in a form:
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdding(false);
                openItem({ kind: 'new-event' });
              }}
            >
              New event
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdding(false);
                openItem({ kind: 'new-task' });
              }}
            >
              New task
            </Button>
          </div>
        </div>
      </Dialog>
      <SearchDialog open={searching} onClose={() => setSearching(false)} />
      <ItemDialog />
      <Toaster />
    </div>
  );
}
