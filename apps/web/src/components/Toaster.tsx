import { CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { dismissToast, useToasts } from '../lib/toast';

const ICON = { success: CircleCheck, error: TriangleAlert, info: Info };

export function Toaster() {
  const toasts = useToasts();
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = ICON[t.kind];
          return (
            <motion.div
              key={t.id}
              layout
              role={t.kind === 'error' ? 'alert' : 'status'}
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 500, damping: 34 }}
              className="pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm shadow-card"
            >
              <Icon
                className={
                  t.kind === 'error'
                    ? 'mt-0.5 size-4 text-danger'
                    : t.kind === 'success'
                      ? 'mt-0.5 size-4 text-ok'
                      : 'mt-0.5 size-4 text-accent-ink'
                }
                aria-hidden
              />
              <div className="flex-1">
                <p className="font-medium">{t.title}</p>
                {t.detail && <p className="text-xs text-muted">{t.detail}</p>}
              </div>
              <button
                onClick={() => dismissToast(t.id)}
                aria-label="Dismiss notification"
                className="text-faint hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
