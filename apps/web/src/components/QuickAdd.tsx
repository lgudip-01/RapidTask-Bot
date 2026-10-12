import type { ParsePreview } from '@planner/shared';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CornerDownLeft, ListTodo, LoaderCircle, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { forwardRef, useState } from 'react';
import { api } from '../lib/api';
import { useDebounced } from '../lib/hooks';
import { useCapture } from '../lib/queries';
import { cx } from './ui';

function PreviewChip({ preview }: { preview: ParsePreview }) {
  if (preview.type === 'capture') {
    const Icon = preview.kind === 'event' ? CalendarDays : ListTodo;
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-accent-soft px-2 py-1 text-xs text-accent-ink">
        <Icon className="size-3.5" aria-hidden />
        <span className="font-medium">{preview.kind === 'event' ? 'Event' : 'Task'}</span>
        <span>
          · {preview.title} · {preview.summary}
        </span>
      </span>
    );
  }
  if (preview.type === 'clarify')
    return <span className="text-xs text-warn">{preview.question}</span>;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      <Sparkles className="size-3.5" aria-hidden /> AI will read this when you press Enter
    </span>
  );
}

/**
 * Natural-language add: "physics lab report fri 5pm". Shows a free, instant preview from the
 * deterministic parser while typing; Enter sends it through the full parser (AI if enabled).
 */
export const QuickAdd = forwardRef<HTMLInputElement, { onAdded?: () => void; autoFocus?: boolean }>(
  function QuickAdd({ onAdded, autoFocus }, ref) {
    const [text, setText] = useState('');
    const [answer, setAnswer] = useState<ParsePreview | null>(null);
    const q = useDebounced(text.trim(), 250);
    const capture = useCapture();
    const preview = useQuery({
      queryKey: ['parse', q],
      queryFn: async () => (await api.parse(q)).preview,
      enabled: q.length >= 3,
      staleTime: 60_000,
    });

    const submit = async () => {
      const t = text.trim();
      if (!t || capture.isPending) return;
      const res = await capture.mutateAsync(t).catch(() => null);
      if (!res) return;
      if (res.created) {
        setText('');
        setAnswer(null);
        onAdded?.();
      } else {
        setAnswer(res.preview);
      }
    };

    const shown = answer ?? (text.trim().length >= 3 ? preview.data : undefined);

    return (
      <div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 shadow-card transition-shadow focus-within:border-accent-ink focus-within:ring-4 focus-within:ring-accent-ink/15"
        >
          <label htmlFor="quick-add" className="sr-only">
            Add a task or event in plain words
          </label>
          <input
            id="quick-add"
            ref={ref}
            autoFocus={autoFocus}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setAnswer(null);
            }}
            placeholder='Add anything… "physics lab report fri 5pm"'
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-faint focus-visible:outline-none"
            autoComplete="off"
            maxLength={500}
          />
          <button
            type="submit"
            disabled={!text.trim() || capture.isPending}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2 text-xs font-medium text-white disabled:opacity-40"
            aria-label="Add"
          >
            {capture.isPending ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <CornerDownLeft className="size-3.5" />
            )}
          </button>
        </form>
        <div className={cx('min-h-7 px-1 pt-1.5')} aria-live="polite">
          <AnimatePresence mode="wait">
            {shown && (
              <motion.div
                key={JSON.stringify(shown)}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                {shown.type === 'error' && answer ? (
                  <span className="text-xs text-danger">{shown.message}</span>
                ) : shown.type === 'off_topic' && answer ? (
                  <span className="text-xs text-muted">
                    That doesn't look like a task or event.
                  </span>
                ) : (
                  <PreviewChip preview={shown} />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    );
  },
);
