import type { CalendarEvent, Task } from '@planner/shared';
import { dateInZone } from '@planner/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, cx, ErrorState, Kbd, Legend, Skeleton, sourceColor } from '../components/ui';
import { useHotkeys, useNow } from '../lib/hooks';
import { openItem } from '../lib/itemDialog';
import { layoutDay } from '../lib/layout';
import { useAgenda } from '../lib/queries';
import {
  addDays,
  dayStart,
  fmtDayNum,
  fmtMonthRange,
  fmtTime,
  fmtWeekday,
  minutesIntoDay,
  todayLocal,
  TZ,
  weekStart,
} from '../lib/time';

const HOUR_PX = 44;
const DAY_MIN = 24 * 60;

/** Clips a timed event to one local day: minutes from that day's midnight. */
function segmentFor(e: CalendarEvent, day: string) {
  const s = dayStart(day).getTime();
  const eod = dayStart(addDays(day, 1)).getTime();
  const start = new Date(e.start).getTime();
  const end = new Date(e.end).getTime();
  if (end <= s || start >= eod) return null;
  return {
    item: e,
    start: start <= s ? 0 : minutesIntoDay(new Date(start)),
    end: end >= eod ? DAY_MIN : minutesIntoDay(new Date(end)),
  };
}

export function WeekView() {
  const now = useNow(60_000);
  const today = todayLocal(now);
  const [anchor, setAnchor] = useState(() => weekStart(today));
  const [dir, setDir] = useState(0);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)), [anchor]);
  const agenda = useAgenda(dayStart(anchor), dayStart(addDays(anchor, 7)));
  const scroller = useRef<HTMLDivElement>(null);

  const go = (weeks: number) => {
    setDir(weeks);
    setAnchor((a) => (weeks === 0 ? weekStart(today) : addDays(a, weeks * 7)));
  };
  useHotkeys({ ArrowLeft: () => go(-1), ArrowRight: () => go(1) });

  useEffect(() => {
    scroller.current?.scrollTo?.({ top: 7 * HOUR_PX - 8 });
  }, []);

  const events = agenda.data?.items.flatMap((i) => (i.kind === 'event' ? [i.item] : [])) ?? [];
  const tasks = agenda.data?.items.flatMap((i) => (i.kind === 'task' ? [i.item] : [])) ?? [];
  const allDay = events.filter((e) => e.allDay);
  const timed = events.filter((e) => !e.allDay);

  const tasksByDay = (day: string) =>
    tasks.filter((t: Task) => t.due && dateInZone(new Date(t.due), TZ) === day);
  /** All-day bars as grid spans (columns 1..7 within this week). */
  const bars = allDay
    .map((e) => {
      const startDay = dateInZone(new Date(e.start), TZ);
      const lastDay = dateInZone(new Date(new Date(e.end).getTime() - 1), TZ);
      const first = Math.max(
        0,
        days.indexOf(startDay) === -1 ? (startDay < days[0]! ? 0 : 7) : days.indexOf(startDay),
      );
      const last =
        days.indexOf(lastDay) === -1 ? (lastDay > days[6]! ? 6 : -1) : days.indexOf(lastDay);
      return { e, first, last };
    })
    .filter((b) => b.first <= b.last && b.first < 7);

  return (
    <div>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="mr-2 text-2xl font-semibold tracking-tight">
            {fmtMonthRange(dayStart(days[0]!), dayStart(days[6]!))}
          </h1>
          <Button size="sm" variant="ghost" onClick={() => go(-1)} aria-label="Previous week">
            <ChevronLeft className="size-4" />
          </Button>
          <Button size="sm" variant="subtle" onClick={() => go(0)}>
            Today
          </Button>
          <Button size="sm" variant="ghost" onClick={() => go(1)} aria-label="Next week">
            <ChevronRight className="size-4" />
          </Button>
          <span className="ml-1 hidden text-xs text-faint md:inline">
            <Kbd>←</Kbd> <Kbd>→</Kbd>
          </span>
        </div>
        <Legend />
      </header>

      {agenda.error && <ErrorState error={agenda.error} onRetry={() => agenda.refetch()} />}

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-card scrollbar-thin">
        <div className="min-w-[760px]">
          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
            <motion.div
              key={anchor}
              custom={dir}
              initial={{ opacity: 0, x: dir * 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: dir * -40 }}
              transition={{ type: 'spring', stiffness: 380, damping: 34 }}
            >
              {/* Day headers */}
              <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-line">
                <div />
                {days.map((d) => (
                  <div key={d} className="px-2 py-2 text-center">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-faint">
                      {fmtWeekday(dayStart(d))}
                    </div>
                    <div
                      className={cx(
                        'mx-auto mt-0.5 grid size-7 place-items-center rounded-full text-sm font-semibold',
                        d === today && 'bg-accent text-white',
                      )}
                    >
                      {fmtDayNum(dayStart(d))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Task chips + all-day bars */}
              <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-line">
                <div className="px-1 py-1.5 text-right text-[10px] text-faint">tasks</div>
                {days.map((d) => (
                  <div key={d} className="min-h-8 space-y-1 border-l border-line p-1">
                    {agenda.isLoading && <Skeleton className="h-5" />}
                    {tasksByDay(d).map((t) => (
                      <motion.button
                        type="button"
                        onClick={() => openItem({ kind: 'task', task: t })}
                        aria-label={`Details: ${t.title}`}
                        key={t.id}
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        whileHover={{ y: -1 }}
                        title={`${t.title}${t.dueAllDay ? '' : ` · due ${fmtTime(t.due!)}`}`}
                        className={cx(
                          'flex w-full items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-left text-[11px]',
                          t.status === 'done'
                            ? 'border-line text-faint line-through'
                            : 'border-line bg-bg',
                        )}
                      >
                        <span
                          aria-hidden
                          className="size-1.5 shrink-0 rounded-sm"
                          style={{ background: sourceColor(t.source) }}
                        />
                        <span className="truncate">{t.title}</span>
                      </motion.button>
                    ))}
                  </div>
                ))}
              </div>
              {bars.length > 0 && (
                <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] gap-y-1 border-b border-line py-1">
                  {bars.map(({ e, first, last }) => (
                    <motion.button
                      type="button"
                      onClick={() => openItem({ kind: 'event', event: e })}
                      aria-label={`Details: ${e.title}`}
                      key={e.id}
                      initial={{ opacity: 0, scaleX: 0.9 }}
                      animate={{ opacity: 1, scaleX: 1 }}
                      style={{
                        gridColumn: `${first + 2} / ${last + 3}`,
                        background: `color-mix(in srgb, ${sourceColor(e.source)} 16%, transparent)`,
                        borderColor: sourceColor(e.source),
                      }}
                      className="mx-1 truncate rounded-md border-l-[3px] px-2 py-0.5 text-left text-[11px] font-medium"
                      title={e.title}
                    >
                      {e.title}
                    </motion.button>
                  ))}
                </div>
              )}

              {/* Hour grid */}
              <div ref={scroller} className="relative h-[62vh] overflow-y-auto scrollbar-thin">
                <div
                  className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]"
                  style={{ height: 24 * HOUR_PX }}
                >
                  <div className="relative">
                    {Array.from({ length: 24 }, (_, h) => (
                      <div
                        key={h}
                        className="absolute right-1.5 -translate-y-1/2 text-[10px] tabular-nums text-faint"
                        style={{ top: h * HOUR_PX }}
                      >
                        {h === 0 ? '' : `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`}
                      </div>
                    ))}
                  </div>
                  {days.map((d) => {
                    const placed = layoutDay(timed.flatMap((e) => segmentFor(e, d) ?? []));
                    const isToday = d === today;
                    return (
                      <div
                        key={d}
                        className={cx(
                          'relative border-l border-line',
                          isToday && 'bg-accent-soft/30',
                        )}
                      >
                        {Array.from({ length: 24 }, (_, h) => (
                          <div
                            key={h}
                            className="absolute inset-x-0 border-t border-line/60"
                            style={{ top: h * HOUR_PX }}
                          />
                        ))}
                        {placed.map((p, idx) => {
                          const e = p.item;
                          const height = Math.max(((p.end - p.start) / 60) * HOUR_PX - 2, 18);
                          return (
                            <motion.button
                              type="button"
                              onClick={() => openItem({ kind: 'event', event: e })}
                              aria-label={`Details: ${e.title}`}
                              key={e.id}
                              initial={{ opacity: 0, y: 4 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: idx * 0.02 }}
                              whileHover={{ scale: 1.02, zIndex: 10 }}
                              className="absolute overflow-hidden rounded-md border-l-[3px] px-1.5 py-1 text-left text-[11px] leading-tight shadow-sm"
                              style={{
                                top: (p.start / 60) * HOUR_PX + 1,
                                height,
                                left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
                                width: `calc(${100 / p.cols}% - 4px)`,
                                background: `color-mix(in srgb, ${sourceColor(e.source)} 14%, var(--surface))`,
                                borderColor: sourceColor(e.source),
                              }}
                              title={`${e.title} · ${fmtTime(e.start)}–${fmtTime(e.end)}${e.location ? ` · ${e.location}` : ''}`}
                            >
                              <div className="truncate font-medium">{e.title}</div>
                              {height > 30 && (
                                <div className="truncate text-muted">
                                  {fmtTime(e.start)}
                                  {e.location ? ` · ${e.location}` : ''}
                                </div>
                              )}
                            </motion.button>
                          );
                        })}
                        {isToday && (
                          <div
                            className="pointer-events-none absolute inset-x-0 z-20"
                            style={{ top: (minutesIntoDay(now) / 60) * HOUR_PX }}
                            aria-hidden
                          >
                            <div className="relative h-0.5 bg-now">
                              <motion.span
                                className="absolute -left-1 -top-1 size-2.5 rounded-full bg-now"
                                animate={{ scale: [1, 1.4, 1] }}
                                transition={{ duration: 2, repeat: Infinity }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
