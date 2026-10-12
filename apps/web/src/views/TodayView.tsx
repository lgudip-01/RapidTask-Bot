import type { AgendaItem, Suggestion } from '@planner/shared';
import { Inbox, Sparkles, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { EventRow, TaskRow } from '../components/items';
import { Button, EmptyState, ErrorState, LoadingRows } from '../components/ui';
import { useNow } from '../lib/hooks';
import { useAgenda, useSuggestionActions, useSuggestions } from '../lib/queries';
import { addDays, dayStart, fmtDay, fmtLong, fmtTime, relative, todayLocal } from '../lib/time';

const CHANNEL_LABEL: Record<string, string> = { telegram: 'Telegram', twilio: 'SMS', web: 'Web' };
const list = { hidden: {}, show: { transition: { staggerChildren: 0.035 } } };
const row = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } };

function Section({
  title,
  count,
  tone,
  children,
}: {
  title: string;
  count?: number;
  tone?: 'danger';
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5">
      <h2
        className={
          tone === 'danger'
            ? 'mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-danger'
            : 'mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-faint'
        }
      >
        {title}
        {count !== undefined && <span className="ml-1.5 font-normal">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function NowLine({ now }: { now: Date }) {
  return (
    <motion.li
      layout
      className="flex items-center gap-2 px-2 py-1"
      aria-label={`Now, ${fmtTime(now)}`}
    >
      <span className="w-[4.5rem] text-right text-[10px] font-semibold tabular-nums text-now">
        {fmtTime(now)}
      </span>
      <span className="relative h-px flex-1 bg-now">
        <motion.span
          className="absolute -left-1 -top-[3px] size-[7px] rounded-full bg-now"
          animate={{ scale: [1, 1.5, 1] }}
          transition={{ duration: 2, repeat: Infinity }}
        />
      </span>
    </motion.li>
  );
}

function itemTime(i: AgendaItem) {
  return new Date(i.kind === 'event' ? i.item.start : i.item.due!).getTime();
}

export function SuggestionTray({ compact = false }: { compact?: boolean }) {
  const q = useSuggestions();
  const { accept, dismiss } = useSuggestionActions();
  const items = q.data ?? [];

  const quickAccept = (s: Suggestion) =>
    accept.mutate({
      id: s.id,
      body: s.proposedDue
        ? { kind: 'task', title: s.proposedTitle, due: s.proposedDue, dueAllDay: false }
        : { kind: 'task', title: s.proposedTitle, due: null, dueAllDay: true },
    });

  return (
    <aside
      aria-label="Suggestions"
      className={compact ? '' : 'rounded-2xl border border-line bg-surface p-3 shadow-card'}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">
          Suggestions <span className="font-normal">({items.length})</span>
        </h2>
        <a href="#/suggestions" className="text-xs text-accent-ink hover:underline">
          Open inbox
        </a>
      </div>
      {q.isLoading && <LoadingRows rows={2} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && items.length === 0 && (
        <p className="px-1 py-4 text-center text-xs text-muted">
          Nothing waiting. Messages the bot couldn't finish land here.
        </p>
      )}
      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {items.slice(0, 4).map((s) => (
            <motion.li
              key={s.id}
              layout
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24, height: 0, marginTop: 0 }}
              className="rounded-xl border border-line bg-bg/50 p-2.5"
            >
              <p className="text-sm font-medium">{s.proposedTitle}</p>
              <p className="mt-0.5 text-xs text-muted">
                {s.proposedDue ? `${fmtDay(s.proposedDue)}, ${fmtTime(s.proposedDue)}` : 'no date'}{' '}
                · via {CHANNEL_LABEL[s.sourceMessageRef.split(':')[0]!] ?? 'message'} ·{' '}
                {relative(s.createdAt)}
              </p>
              <div className="mt-2 flex gap-1.5">
                <Button size="sm" variant="primary" onClick={() => quickAccept(s)}>
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => (window.location.hash = '/suggestions')}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => dismiss.mutate(s.id)}
                  aria-label={`Dismiss ${s.proposedTitle}`}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </aside>
  );
}

export function TodayView() {
  const now = useNow(30_000);
  const today = todayLocal(now);
  const from = dayStart(today);
  const to = dayStart(addDays(today, 1));
  const agenda = useAgenda(from, to, true);
  const suggestions = useSuggestions();
  const [trayOpen, setTrayOpen] = useState(false);

  const items = agenda.data?.items ?? [];
  const overdue = items.filter(
    (i) => i.kind === 'task' && i.overdue && new Date(i.item.due!) < from,
  );
  const allDay = items.filter(
    (i) =>
      (i.kind === 'event' && i.item.allDay) ||
      (i.kind === 'task' && i.item.dueAllDay && !overdue.includes(i)),
  );
  const timed = items
    .filter((i) => !overdue.includes(i) && !allDay.includes(i))
    .sort((a, b) => itemTime(a) - itemTime(b));
  const nowIndex = timed.findIndex((i) => itemTime(i) > now.getTime());
  const counts = {
    events: items.filter((i) => i.kind === 'event').length,
    tasks: items.filter((i) => i.kind === 'task' && i.item.status !== 'done').length,
  };

  const render = (i: AgendaItem) =>
    i.kind === 'event' ? (
      <EventRow event={i.item} now={now} />
    ) : (
      <TaskRow task={i.item} overdue={i.overdue} />
    );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div>
        <header className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{fmtLong(now)}</h1>
            <p className="mt-1 text-sm text-muted">
              {counts.events} events · {counts.tasks} open tasks
              {overdue.length > 0 && (
                <span className="text-danger"> · {overdue.length} overdue</span>
              )}
            </p>
          </div>
          <div className="lg:hidden">
            <Button
              variant="subtle"
              size="sm"
              onClick={() => setTrayOpen((v) => !v)}
              aria-expanded={trayOpen}
            >
              <Inbox className="size-3.5" aria-hidden /> Suggestions (
              {suggestions.data?.length ?? 0})
            </Button>
          </div>
        </header>

        <AnimatePresence>
          {trayOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mb-5 overflow-hidden lg:hidden"
            >
              <div className="rounded-2xl border border-line bg-surface p-3">
                <SuggestionTray compact />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {agenda.isLoading && <LoadingRows rows={6} />}
        {agenda.error && <ErrorState error={agenda.error} onRetry={() => agenda.refetch()} />}
        {agenda.data && items.length === 0 && (
          <EmptyState
            icon={<Sparkles className="size-6" />}
            title="A clear day."
            hint={
              <>
                Press <b>n</b> to add something, or text your bot.
              </>
            }
          />
        )}

        {agenda.data && items.length > 0 && (
          <div className="rounded-2xl border border-line bg-surface p-3 shadow-card">
            {overdue.length > 0 && (
              <Section title="Overdue" count={overdue.length} tone="danger">
                <motion.ul variants={list} initial="hidden" animate="show">
                  {overdue.map((i) => (
                    <motion.li key={i.item.id} variants={row} layout>
                      {render(i)}
                    </motion.li>
                  ))}
                </motion.ul>
              </Section>
            )}
            {allDay.length > 0 && (
              <Section title="All day">
                <motion.ul variants={list} initial="hidden" animate="show">
                  {allDay.map((i) => (
                    <motion.li key={i.item.id} variants={row} layout>
                      {render(i)}
                    </motion.li>
                  ))}
                </motion.ul>
              </Section>
            )}
            <Section title="Timeline">
              <motion.ul variants={list} initial="hidden" animate="show">
                {timed.map((i, idx) => (
                  <div key={i.item.id}>
                    {idx === nowIndex && <NowLine now={now} />}
                    <motion.li variants={row} layout>
                      {render(i)}
                    </motion.li>
                  </div>
                ))}
                {(nowIndex === -1 || timed.length === 0) && <NowLine now={now} />}
              </motion.ul>
            </Section>
          </div>
        )}
      </div>
      <div className="hidden lg:block">
        <div className="sticky top-20">
          <SuggestionTray />
        </div>
      </div>
    </div>
  );
}
