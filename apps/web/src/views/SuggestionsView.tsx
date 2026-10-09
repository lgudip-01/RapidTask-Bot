import type { AcceptSuggestion, Suggestion } from '@planner/shared';
import { dateInZone, zonedTimeToUtc } from '@planner/shared';
import { Check, Inbox, Pencil, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Button, EmptyState, ErrorState, LoadingRows, Segmented } from '../components/ui';
import { useSuggestionActions, useSuggestions } from '../lib/queries';
import { addDays, fmtDay, fmtTime, minutesIntoDay, relative, TZ } from '../lib/time';

const CHANNEL_LABEL: Record<string, string> = { telegram: 'Telegram', twilio: 'SMS', web: 'Web' };

function toInstant(date: string, time: string) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return zonedTimeToUtc(TZ, y!, m!, d!, hh!, mm!).toISOString();
}

function EditForm({
  s,
  onCancel,
  onSave,
}: {
  s: Suggestion;
  onCancel: () => void;
  onSave: (b: AcceptSuggestion) => void;
}) {
  const due = s.proposedDue ? new Date(s.proposedDue) : null;
  const [kind, setKind] = useState<'task' | 'event'>('task');
  const [title, setTitle] = useState(s.proposedTitle);
  const [date, setDate] = useState(due ? dateInZone(due, TZ) : '');
  const [time, setTime] = useState(() => {
    if (!due) return '';
    const m = minutesIntoDay(due);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  });
  const [minutes, setMinutes] = useState(60);

  const valid = title.trim() && (kind === 'task' || date);
  const save = () => {
    if (!valid) return;
    if (kind === 'task') {
      onSave({
        kind,
        title: title.trim(),
        due: date ? (time ? toInstant(date, time) : toInstant(date, '00:00')) : null,
        dueAllDay: !time,
      });
    } else if (!time) {
      onSave({
        kind,
        title: title.trim(),
        when: { allDay: true, startDate: date, endDate: addDays(date, 1) },
      });
    } else {
      const start = toInstant(date, time);
      onSave({
        kind,
        title: title.trim(),
        when: {
          allDay: false,
          start,
          end: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
        },
      });
    }
  };

  return (
    <motion.form
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      className="overflow-hidden"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
        <label className="text-xs text-muted sm:col-span-2">
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-line bg-bg px-2.5 text-sm text-ink"
          />
        </label>
        <div className="sm:col-span-2">
          <Segmented
            id={`kind-${s.id}`}
            label="Create as"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'task', label: 'Task' },
              { value: 'event', label: 'Event' },
            ]}
          />
        </div>
        <label className="text-xs text-muted">
          Date {kind === 'event' && <span className="text-danger">*</span>}
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-line bg-bg px-2.5 text-sm text-ink"
          />
        </label>
        <label className="text-xs text-muted">
          Time (optional)
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-line bg-bg px-2.5 text-sm text-ink"
          />
        </label>
        {kind === 'event' && time && (
          <label className="text-xs text-muted">
            Duration (minutes)
            <input
              type="number"
              min={5}
              step={5}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value) || 60)}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-bg px-2.5 text-sm text-ink"
            />
          </label>
        )}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={!valid}>
          <Check className="size-3.5" /> Save & add
        </Button>
      </div>
    </motion.form>
  );
}

function Card({ s }: { s: Suggestion }) {
  const { accept, dismiss } = useSuggestionActions();
  const [editing, setEditing] = useState(false);
  const [channel] = s.sourceMessageRef.split(':');

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.2 } }}
      className="rounded-2xl border border-line bg-surface p-4 shadow-card"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[15px] font-medium">{s.proposedTitle}</p>
          <p className="mt-1 text-xs text-muted">
            {s.proposedDue ? `${fmtDay(s.proposedDue)}, ${fmtTime(s.proposedDue)}` : 'No date yet'}{' '}
            · via {CHANNEL_LABEL[channel!] ?? channel} · {relative(s.createdAt)}
          </p>
        </div>
        <div
          className="w-24 shrink-0"
          title={`Parser confidence ${Math.round(s.confidence * 100)}%`}
        >
          <div className="text-right text-[10px] text-faint">confidence</div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <motion.div
              className="h-full rounded-full bg-accent"
              initial={{ width: 0 }}
              animate={{ width: `${s.confidence * 100}%` }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
            />
          </div>
        </div>
      </div>
      {!editing && (
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              s.proposedDue
                ? accept.mutate({
                    id: s.id,
                    body: {
                      kind: 'task',
                      title: s.proposedTitle,
                      due: s.proposedDue,
                      dueAllDay: false,
                    },
                  })
                : setEditing(true)
            }
          >
            <Check className="size-3.5" /> Accept
          </Button>
          <Button size="sm" variant="subtle" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" /> Edit
          </Button>
          <Button size="sm" variant="danger" onClick={() => dismiss.mutate(s.id)}>
            <X className="size-3.5" /> Dismiss
          </Button>
        </div>
      )}
      <AnimatePresence>
        {editing && (
          <EditForm
            s={s}
            onCancel={() => setEditing(false)}
            onSave={(body) => accept.mutate({ id: s.id, body })}
          />
        )}
      </AnimatePresence>
    </motion.li>
  );
}

export function SuggestionsView() {
  const q = useSuggestions();
  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Suggestions</h1>
        <p className="mt-1 text-sm text-muted">
          Messages the bot couldn't finish on its own. Accept, fix, or dismiss them.
        </p>
      </header>
      {q.isLoading && <LoadingRows rows={3} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.length === 0 && (
        <EmptyState
          icon={<Inbox className="size-6" />}
          title="Inbox zero."
          hint="When a texted message needs a decision, it shows up here."
        />
      )}
      <ul className="space-y-3">
        <AnimatePresence initial={false}>
          {q.data?.map((s) => (
            <Card key={s.id} s={s} />
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}
