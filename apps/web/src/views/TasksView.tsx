import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Source, Task, TaskStatus } from '@planner/shared';
import { dateInZone } from '@planner/shared';
import { GripVertical, Kanban, List, ListTodo, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { forwardRef, useMemo, useState } from 'react';
import { TaskRow } from '../components/items';
import { QuickAdd } from '../components/QuickAdd';
import { cx, EmptyState, ErrorState, LoadingRows, Segmented, SOURCE_META } from '../components/ui';
import { useDeleteTask, useTasks, useUpdateTask } from '../lib/queries';
import { addDays, todayLocal, TZ } from '../lib/time';

type Group = 'overdue' | 'today' | 'week' | 'later' | 'nodate' | 'done';
const GROUPS: { id: Group; title: string }[] = [
  { id: 'overdue', title: 'Overdue' },
  { id: 'today', title: 'Today' },
  { id: 'week', title: 'Next 7 days' },
  { id: 'later', title: 'Later' },
  { id: 'nodate', title: 'No date' },
  { id: 'done', title: 'Done' },
];

function groupOf(t: Task, today: string): Group {
  if (t.status === 'done') return 'done';
  if (!t.due) return 'nodate';
  const d = dateInZone(new Date(t.due), TZ);
  if (d < today) return 'overdue';
  if (d === today) return 'today';
  return d <= addDays(today, 7) ? 'week' : 'later';
}

const byOrder = (a: Task, b: Task) =>
  a.sortOrder - b.sortOrder ||
  (a.due ?? '9').localeCompare(b.due ?? '9') ||
  a.title.localeCompare(b.title);

function SortableTask({ task, overdue }: { task: Task; overdue: boolean }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: task.id,
  });
  const del = useDeleteTask();
  return (
    <motion.li
      ref={setNodeRef}
      layout={!isDragging}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 20 : undefined,
      }}
      className={cx(
        'group/row relative rounded-lg',
        isDragging && 'bg-surface shadow-card ring-1 ring-accent/40',
      )}
    >
      <TaskRow
        task={task}
        overdue={overdue}
        handle={
          <button
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${task.title}`}
            className="cursor-grab touch-none text-faint opacity-0 transition-opacity group-hover/row:opacity-100 focus:opacity-100 active:cursor-grabbing"
          >
            <GripVertical className="size-4" />
          </button>
        }
      />
      {task.source === 'local' && (
        <button
          onClick={() => del.mutate(task.id)}
          aria-label={`Delete ${task.title}`}
          className="absolute right-8 top-1/2 -translate-y-1/2 text-faint opacity-0 transition-opacity group-hover/row:opacity-100 focus:opacity-100 hover:text-danger"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </motion.li>
  );
}

function ListMode({ tasks }: { tasks: Task[] }) {
  const today = todayLocal();
  const update = useUpdateTask();
  const [showDone, setShowDone] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const grouped = useMemo(() => {
    const m = new Map<Group, Task[]>(GROUPS.map((g) => [g.id, []]));
    for (const t of tasks) m.get(groupOf(t, today))!.push(t);
    for (const list of m.values()) list.sort(byOrder);
    return m;
  }, [tasks, today]);

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const group = [...grouped.values()].find((l) => l.some((t) => t.id === e.active.id));
    if (!group || !group.some((t) => t.id === e.over!.id)) return; // reorder within a group only
    const ids = group.map((t) => t.id);
    const moved = arrayMove(
      group,
      ids.indexOf(String(e.active.id)),
      ids.indexOf(String(e.over.id)),
    );
    const i = moved.findIndex((t) => t.id === e.active.id);
    const prev = moved[i - 1]?.sortOrder;
    const next = moved[i + 1]?.sortOrder;
    const sortOrder =
      prev === undefined ? next! - 1 : next === undefined ? prev + 1 : (prev + next) / 2;
    update.mutate({ id: String(e.active.id), patch: { sortOrder } });
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <div className="space-y-4">
        {GROUPS.map(({ id, title }) => {
          const list = grouped.get(id)!;
          if (!list.length) return null;
          const collapsed = id === 'done' && !showDone;
          return (
            <section key={id} aria-label={title}>
              <button
                className={cx(
                  'mb-1 px-2 text-xs font-semibold uppercase tracking-wide',
                  id === 'overdue' ? 'text-danger' : 'text-faint',
                  id === 'done' && 'hover:text-ink',
                )}
                onClick={() => id === 'done' && setShowDone((v) => !v)}
                aria-expanded={id === 'done' ? showDone : undefined}
                disabled={id !== 'done'}
              >
                {title} <span className="font-normal">{list.length}</span>
                {id === 'done' && (
                  <span className="ml-1 font-normal normal-case">
                    {showDone ? '· hide' : '· show'}
                  </span>
                )}
              </button>
              {!collapsed && (
                <SortableContext
                  items={list.map((t) => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <ul>
                    <AnimatePresence initial={false}>
                      {list.map((t) => (
                        <SortableTask key={t.id} task={t} overdue={id === 'overdue'} />
                      ))}
                    </AnimatePresence>
                  </ul>
                </SortableContext>
              )}
            </section>
          );
        })}
      </div>
    </DndContext>
  );
}

const COLUMNS: { id: TaskStatus; title: string }[] = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'Doing' },
  { id: 'done', title: 'Done' },
];

function BoardCard({ task }: { task: Task }) {
  const { setNodeRef, attributes, listeners, transform, isDragging } = useDraggable({
    id: task.id,
  });
  return (
    <motion.li
      ref={setNodeRef}
      layout={!isDragging}
      layoutId={`card-${task.id}`}
      {...attributes}
      {...listeners}
      style={{
        transform: CSS.Translate.toString(transform),
        zIndex: isDragging ? 30 : undefined,
      }}
      className={cx(
        'cursor-grab touch-none rounded-xl border border-line bg-surface shadow-card active:cursor-grabbing',
        isDragging && 'ring-1 ring-accent/50',
      )}
      aria-roledescription="draggable task"
    >
      <TaskRow task={task} dense />
    </motion.li>
  );
}

function BoardColumn({ id, title, tasks }: { id: TaskStatus; title: string; tasks: Task[] }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section
      ref={setNodeRef}
      aria-label={title}
      className={cx(
        'min-h-48 rounded-2xl border border-line bg-surface-2/60 p-2 transition-colors',
        isOver && 'border-accent bg-accent-soft/50',
      )}
    >
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-faint">
        {title} <span className="font-normal">{tasks.length}</span>
      </h2>
      <ul className="space-y-2">
        {tasks.map((t) => (
          <BoardCard key={t.id} task={t} />
        ))}
      </ul>
      {tasks.length === 0 && (
        <p className="px-1 py-6 text-center text-xs text-faint">Drop tasks here</p>
      )}
    </section>
  );
}

function BoardMode({ tasks }: { tasks: Task[] }) {
  const update = useUpdateTask();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );
  const onDragEnd = (e: DragEndEvent) => {
    const status = e.over?.id as TaskStatus | undefined;
    const task = tasks.find((t) => t.id === e.active.id);
    if (status && task && task.status !== status) update.mutate({ id: task.id, patch: { status } });
  };
  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="grid gap-3 md:grid-cols-3">
        {COLUMNS.map((c) => (
          <BoardColumn
            key={c.id}
            id={c.id}
            title={c.title}
            tasks={tasks.filter((t) => t.status === c.id).sort(byOrder)}
          />
        ))}
      </div>
    </DndContext>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 rounded-md border border-line bg-surface px-1.5 text-xs text-ink"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export const TasksView = forwardRef<HTMLInputElement>(function TasksView(_props, quickAddRef) {
  const q = useTasks();
  const [mode, setMode] = useState<'list' | 'board'>('list');
  const [source, setSource] = useState<'all' | Source>('all');
  const [course, setCourse] = useState('all');
  const [status, setStatus] = useState<'open' | 'all'>('all');

  const courses = useMemo(
    () =>
      [...new Set((q.data ?? []).map((t) => t.courseOrProject).filter(Boolean) as string[])].sort(),
    [q.data],
  );
  const filtered = (q.data ?? []).filter(
    (t) =>
      (source === 'all' || t.source === source) &&
      (course === 'all' || t.courseOrProject === course) &&
      (status === 'all' || mode === 'board' || t.status !== 'done'),
  );

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-4">
        <h1 className="mb-3 text-2xl font-semibold tracking-tight">Tasks</h1>
        <QuickAdd ref={quickAddRef} />
      </header>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          id="task-mode"
          label="Layout"
          value={mode}
          onChange={setMode}
          options={[
            {
              value: 'list',
              label: (
                <>
                  <List className="size-3.5" /> List
                </>
              ),
            },
            {
              value: 'board',
              label: (
                <>
                  <Kanban className="size-3.5" /> Board
                </>
              ),
            },
          ]}
        />
        <Select
          label="Source"
          value={source}
          onChange={(v) => setSource(v as typeof source)}
          options={[
            { value: 'all', label: 'All' },
            ...(['google_tasks', 'canvas', 'local'] as Source[]).map((s) => ({
              value: s,
              label: SOURCE_META[s].label,
            })),
          ]}
        />
        <Select
          label="Course"
          value={course}
          onChange={setCourse}
          options={[
            { value: 'all', label: 'All' },
            ...courses.map((c) => ({ value: c, label: c })),
          ]}
        />
        {mode === 'list' && (
          <Select
            label="Status"
            value={status}
            onChange={(v) => setStatus(v as typeof status)}
            options={[
              { value: 'all', label: 'All' },
              { value: 'open', label: 'Open' },
            ]}
          />
        )}
      </div>
      {q.isLoading && <LoadingRows rows={7} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && filtered.length === 0 && (
        <EmptyState
          icon={<ListTodo className="size-6" />}
          title={q.data.length ? 'No tasks match these filters.' : 'No tasks yet.'}
          hint="Type above — dates like “fri 5pm” are understood."
        />
      )}
      {filtered.length > 0 && (
        <AnimatePresence mode="wait">
          <motion.div
            key={mode}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            className={
              mode === 'list' ? 'rounded-2xl border border-line bg-surface p-3 shadow-card' : ''
            }
          >
            {mode === 'list' ? <ListMode tasks={filtered} /> : <BoardMode tasks={filtered} />}
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
});
