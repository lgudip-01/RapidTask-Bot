import type { CalendarEvent, SubmissionStatus, Task } from '@planner/shared';
import { ExternalLink, MapPin } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { openItem } from '../lib/itemDialog';
import { useUpdateTask } from '../lib/queries';
import { fmtDay, fmtTime, todayLocal } from '../lib/time';
import { dateInZone } from '@planner/shared';
import { TZ } from '../lib/time';
import { Checkbox } from './Checkbox';
import { cx, SourceBadge, sourceColor } from './ui';

const SUBMISSION: Partial<Record<SubmissionStatus, { label: string; cls: string }>> = {
  missing: { label: 'missing', cls: 'bg-danger-soft text-danger' },
  late: { label: 'late', cls: 'bg-warn-soft text-warn' },
  submitted: { label: 'submitted', cls: 'bg-ok-soft text-ok' },
  graded: { label: 'graded', cls: 'bg-ok-soft text-ok' },
  excused: { label: 'excused', cls: 'bg-surface-2 text-muted' },
};

export function dueLabel(t: Task): string | null {
  if (!t.due) return null;
  const sameDay = dateInZone(new Date(t.due), TZ) === todayLocal();
  if (t.dueAllDay) return sameDay ? 'today' : fmtDay(t.due);
  return sameDay ? fmtTime(t.due) : `${fmtDay(t.due)}, ${fmtTime(t.due)}`;
}

/** A task line with an animated check-off. Shared by Today and Tasks. */
export function TaskRow({
  task,
  overdue,
  handle,
  dense = false,
}: {
  task: Task;
  overdue?: boolean;
  handle?: ReactNode;
  dense?: boolean;
}) {
  const update = useUpdateTask();
  const done = task.status === 'done';
  const sub = task.submissionStatus ? SUBMISSION[task.submissionStatus] : undefined;
  const due = dueLabel(task);

  return (
    <div
      className={cx(
        'group flex items-center gap-3 rounded-lg px-2',
        dense ? 'py-1.5' : 'py-2',
        'hover:bg-surface-2',
      )}
    >
      {handle}
      <Checkbox
        checked={done}
        label={`${done ? 'Mark not done' : 'Mark done'}: ${task.title}`}
        color={sourceColor(task.source)}
        onChange={(v) => update.mutate({ id: task.id, patch: { status: v ? 'done' : 'todo' } })}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => openItem({ kind: 'task', task })}
            aria-label={`Details: ${task.title}`}
            className={cx(
              'relative truncate text-left text-sm transition-colors hover:underline',
              done && 'text-faint',
            )}
          >
            {task.title}
            <motion.span
              aria-hidden
              className="absolute inset-x-0 top-1/2 h-px origin-left bg-faint"
              initial={false}
              animate={{ scaleX: done ? 1 : 0 }}
              transition={{ duration: 0.25 }}
            />
          </button>
          {task.status === 'doing' && (
            <span className="rounded bg-accent-soft px-1.5 text-[10px] font-medium text-accent">
              doing
            </span>
          )}
          {sub && !done && (
            <span className={cx('rounded px-1.5 text-[10px] font-medium', sub.cls)}>
              {sub.label}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted">
          {due && (
            <span className={cx(overdue && !done && 'font-medium text-danger')}>
              {overdue && !done ? `overdue · ${due}` : `due ${due}`}
            </span>
          )}
          {task.courseOrProject && <span className="truncate">{task.courseOrProject}</span>}
          {task.pointsPossible != null && <span>{task.pointsPossible} pts</span>}
          <SourceBadge source={task.source} />
        </div>
      </div>
      {task.url && (
        <a
          href={task.url}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`Open ${task.title} in ${task.source}`}
          className="text-faint opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 hover:text-ink"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </div>
  );
}

export function EventRow({ event, now }: { event: CalendarEvent; now: Date }) {
  const start = new Date(event.start);
  const end = new Date(event.end);
  const live = !event.allDay && start <= now && now < end;
  const past = !event.allDay && end <= now;
  return (
    <div
      className={cx(
        'flex items-stretch gap-3 rounded-lg px-2 py-2 hover:bg-surface-2',
        past && 'opacity-55',
      )}
    >
      <div className="w-[4.5rem] shrink-0 pt-0.5 text-right text-xs tabular-nums text-muted">
        {event.allDay ? 'all day' : fmtTime(start)}
        {!event.allDay && <div className="text-faint">{fmtTime(end)}</div>}
      </div>
      <span
        aria-hidden
        className="w-1 shrink-0 rounded-full"
        style={{ background: sourceColor(event.source) }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => openItem({ kind: 'event', event })}
            aria-label={`Details: ${event.title}`}
            className="truncate text-left text-sm font-medium hover:underline"
          >
            {event.title}
          </button>
          {live && (
            <motion.span
              className="rounded bg-accent px-1.5 text-[10px] font-semibold text-white"
              animate={{ opacity: [1, 0.55, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
            >
              now
            </motion.span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-xs text-muted">
          {event.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3" aria-hidden />
              {event.location}
            </span>
          )}
          {event.calendarName && <span className="truncate">{event.calendarName}</span>}
          <SourceBadge source={event.source} />
        </div>
      </div>
    </div>
  );
}
