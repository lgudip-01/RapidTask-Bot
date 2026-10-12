import {
  addDays,
  dateInZone,
  zonedParts,
  zonedTimeToUtc,
  type CalendarEvent,
  type Task,
  type TaskStatus,
} from '@planner/shared';
import { ExternalLink, Lock } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { closeItem, useItemTarget, type ItemTarget } from '../lib/itemDialog';
import {
  useCreateEvent,
  useCreateTask,
  useDeleteEvent,
  useDeleteTask,
  useUpdateEvent,
  useUpdateTask,
} from '../lib/queries';
import { dayStart, fmtDay, fmtTime, TZ } from '../lib/time';
import { Checkbox } from './Checkbox';
import { Dialog } from './Dialog';
import { Button, Segmented, SOURCE_META, SourceBadge, sourceColor } from './ui';

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date | string) => dateInZone(new Date(d), TZ);
const localTime = (d: Date | string) => {
  const p = zonedParts(new Date(d), TZ);
  return `${pad(p.hour)}:${pad(p.minute)}`;
};
/** Wall-clock date + time in the owner's zone → ISO instant (DST-aware). */
const instant = (date: string, time: string) => {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  return zonedTimeToUtc(TZ, y!, m!, d!, h!, min!).toISOString();
};

const field =
  'mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink placeholder:text-faint';
const labelCls = 'block text-xs font-medium text-muted';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={labelCls}>
      {label}
      {children}
    </label>
  );
}

function titleFor(t: ItemTarget) {
  if (t.kind === 'new-task') return 'New task';
  if (t.kind === 'new-event') return 'New event';
  const source = t.kind === 'task' ? t.task.source : t.event.source;
  const noun = t.kind === 'task' ? 'task' : 'event';
  return source === 'local' ? `Edit ${noun}` : `${noun[0]!.toUpperCase()}${noun.slice(1)} details`;
}

/** Details for any item. Planner items are editable; Google and Canvas items are read-only. */
export function ItemDialog() {
  const target = useItemTarget();
  return (
    <Dialog open={!!target} onClose={closeItem} label={target ? titleFor(target) : 'Item'}>
      {target && <ItemBody target={target} />}
    </Dialog>
  );
}

function ItemBody({ target }: { target: ItemTarget }) {
  const heading = (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
      <h2 className="text-sm font-semibold">{titleFor(target)}</h2>
      {target.kind === 'task' && <SourceBadge source={target.task.source} />}
      {target.kind === 'event' && <SourceBadge source={target.event.source} />}
      {(target.kind === 'new-task' || target.kind === 'new-event') && (
        <SourceBadge source="local" />
      )}
    </div>
  );
  let body: ReactNode;
  if (target.kind === 'new-task') body = <TaskForm />;
  else if (target.kind === 'new-event') body = <EventForm />;
  else if (target.kind === 'task')
    body =
      target.task.source === 'local' ? (
        <TaskForm task={target.task} />
      ) : (
        <ReadOnlyTask task={target.task} />
      );
  else
    body =
      target.event.source === 'local' ? (
        <EventForm event={target.event} />
      ) : (
        <ReadOnlyEvent event={target.event} />
      );
  return (
    <div>
      {heading}
      <div className="max-h-[70vh] overflow-y-auto p-4">{body}</div>
    </div>
  );
}

function LocalNote() {
  return (
    <p className="mb-3 text-xs text-muted">
      Saved only in Planner. Nothing is sent to Google Calendar or Canvas.
    </p>
  );
}

function DeleteButton({ onDelete, busy }: { onDelete: () => void; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Button
      type="button"
      variant="danger"
      size="sm"
      disabled={busy}
      onClick={() => (confirming ? onDelete() : setConfirming(true))}
    >
      {confirming ? 'Confirm delete' : 'Delete'}
    </Button>
  );
}

function TaskForm({ task }: { task?: Task }) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [date, setDate] = useState(task?.due ? localDate(task.due) : '');
  const [time, setTime] = useState(task?.due && !task.dueAllDay ? localTime(task.due) : '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'todo');
  const create = useCreateTask();
  const update = useUpdateTask();
  const del = useDeleteTask();
  const busy = create.isPending || update.isPending || del.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const fields = {
      title: title.trim(),
      notes: notes.trim() || null,
      due: date ? (time ? instant(date, time) : dayStart(date).toISOString()) : null,
      dueAllDay: !time,
      status,
    };
    if (task) update.mutate({ id: task.id, patch: fields }, { onSuccess: closeItem });
    else create.mutate(fields, { onSuccess: closeItem });
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <LocalNote />
      <Field label="Title">
        <input
          className={field}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={500}
          autoFocus
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Due date">
          <input
            type="date"
            className={field}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="Due time (optional)">
          <input
            type="time"
            className={field}
            value={time}
            disabled={!date}
            onChange={(e) => setTime(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Notes">
        <textarea
          className={field}
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      <div>
        <span className={labelCls}>Status</span>
        <div className="mt-1">
          <Segmented
            id="task-status"
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'todo', label: 'To do' },
              { value: 'doing', label: 'Doing' },
              { value: 'done', label: 'Done' },
            ]}
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 pt-2">
        {task ? (
          <DeleteButton
            busy={busy}
            onDelete={() => del.mutate(task.id, { onSuccess: closeItem })}
          />
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={closeItem}>
            Cancel
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={busy || !title.trim()}>
            {task ? 'Save' : 'Add task'}
          </Button>
        </div>
      </div>
    </form>
  );
}

function nextHalfHour(now = new Date()) {
  const step = 30 * 60_000;
  return new Date(Math.ceil((now.getTime() + 1) / step) * step);
}

function EventForm({ event }: { event?: CalendarEvent }) {
  const start0 = event ? new Date(event.start) : nextHalfHour();
  const end0 = event ? new Date(event.end) : new Date(start0.getTime() + 3_600_000);
  const [title, setTitle] = useState(event?.title ?? '');
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [date, setDate] = useState(localDate(start0));
  // All-day ends are exclusive; the form shows the last day.
  const [lastDate, setLastDate] = useState(
    event?.allDay ? localDate(new Date(end0.getTime() - 1)) : localDate(start0),
  );
  const [from, setFrom] = useState(localTime(start0));
  const [to, setTo] = useState(localTime(end0));
  const [location, setLocation] = useState(event?.location ?? '');
  const [notes, setNotes] = useState(event?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateEvent();
  const update = useUpdateEvent();
  const del = useDeleteEvent();
  const busy = create.isPending || update.isPending || del.isPending;
  const overnight = !allDay && to <= from;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (allDay && lastDate < date) return setError('The last day can’t be before the first day.');
    if (!allDay && to === from) return setError('The event needs an end time after its start.');
    setError(null);
    const when = allDay
      ? { allDay: true as const, startDate: date, endDate: addDays(lastDate, 1) }
      : {
          allDay: false as const,
          start: instant(date, from),
          end: instant(overnight ? addDays(date, 1) : date, to),
        };
    const body = {
      title: title.trim(),
      when,
      location: location.trim() || null,
      description: notes.trim() || null,
    };
    if (event) update.mutate({ id: event.id, patch: body }, { onSuccess: closeItem });
    else create.mutate(body, { onSuccess: closeItem });
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <LocalNote />
      <Field label="Title">
        <input
          className={field}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={500}
          autoFocus
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        All day
      </label>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label={allDay ? 'First day' : 'Date'}>
          <input
            type="date"
            className={field}
            value={date}
            required
            onChange={(e) => {
              setDate(e.target.value);
              if (lastDate < e.target.value) setLastDate(e.target.value);
            }}
          />
        </Field>
        {allDay ? (
          <Field label="Last day">
            <input
              type="date"
              className={field}
              value={lastDate}
              min={date}
              required
              onChange={(e) => setLastDate(e.target.value)}
            />
          </Field>
        ) : (
          <>
            <Field label="Starts">
              <input
                type="time"
                className={field}
                value={from}
                required
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field label={overnight ? 'Ends (next day)' : 'Ends'}>
              <input
                type="time"
                className={field}
                value={to}
                required
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
          </>
        )}
      </div>
      <Field label="Location">
        <input className={field} value={location} onChange={(e) => setLocation(e.target.value)} />
      </Field>
      <Field label="Notes">
        <textarea
          className={field}
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2 pt-2">
        {event ? (
          <DeleteButton
            busy={busy}
            onDelete={() => del.mutate(event.id, { onSuccess: closeItem })}
          />
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={closeItem}>
            Cancel
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={busy || !title.trim()}>
            {event ? 'Save' : 'Add event'}
          </Button>
        </div>
      </div>
    </form>
  );
}

function ReadOnlyNotice({ source, noun }: { source: 'google_calendar' | 'canvas'; noun: string }) {
  const label = SOURCE_META[source].label;
  return (
    <p className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
      <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        <b className="text-ink">Read-only.</b> This {noun} comes from {label}. Planner never changes
        it; to edit it, use {label}.
      </span>
    </p>
  );
}

function Details({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  return (
    <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function OpenLink({ url, label }: { url: string | null; label: string }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-ink hover:underline"
    >
      Open in {label} <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );
}

function ReadOnlyTask({ task }: { task: Task }) {
  const update = useUpdateTask();
  const source = task.source as 'canvas';
  const done = task.status === 'done';
  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold">{task.title}</h3>
      <ReadOnlyNotice source={source} noun="assignment" />
      <Details
        rows={[
          [
            'Due',
            task.due
              ? `${fmtDay(task.due)}${task.dueAllDay ? '' : `, ${fmtTime(task.due)}`}`
              : 'No date',
          ],
          ['Course', task.courseOrProject],
          ['Points', task.pointsPossible],
          ['Submission', task.submissionStatus],
          ['Notes', task.notes],
        ]}
      />
      <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
        <Checkbox
          checked={done}
          color={sourceColor(task.source)}
          label={`${done ? 'Mark not done' : 'Mark done'} in Planner: ${task.title}`}
          onChange={(v) => update.mutate({ id: task.id, patch: { status: v ? 'done' : 'todo' } })}
        />
        <span className="text-xs text-muted">
          Check it off here to track your progress. It’s saved only in Planner; Canvas isn’t
          changed.
        </span>
      </div>
      <OpenLink url={task.url} label={SOURCE_META[task.source].label} />
    </div>
  );
}

function ReadOnlyEvent({ event }: { event: CalendarEvent }) {
  const source = event.source as 'google_calendar' | 'canvas';
  const when = event.allDay
    ? (() => {
        const last = new Date(new Date(event.end).getTime() - 1);
        const a = fmtDay(event.start);
        const b = fmtDay(last);
        return a === b ? `${a} (all day)` : `${a} – ${b} (all day)`;
      })()
    : `${fmtDay(event.start)}, ${fmtTime(event.start)} – ${fmtTime(event.end)}`;
  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold">{event.title}</h3>
      <ReadOnlyNotice source={source} noun="event" />
      <Details
        rows={[
          ['When', when],
          ['Where', event.location],
          ['Calendar', event.calendarName],
          ['Notes', event.description],
        ]}
      />
      <OpenLink url={event.url} label={SOURCE_META[event.source].label} />
    </div>
  );
}
