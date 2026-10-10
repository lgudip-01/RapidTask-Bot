import type { Source } from '@planner/shared';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { motion } from 'motion/react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export const SOURCE_META: Record<Source, { label: string; short: string }> = {
  google_calendar: { label: 'Google Calendar', short: 'GCal' },
  canvas: { label: 'Canvas', short: 'Canvas' },
  local: { label: 'Planner', short: 'Local' },
};
export const sourceColor = (s: Source) => `var(--src-${s})`;

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

/** Colored dot + optional label. Color is paired with text so it is never the only cue. */
export function SourceBadge({ source, compact = false }: { source: Source; compact?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-muted"
      title={SOURCE_META[source].label}
    >
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{ background: sourceColor(source) }}
      />
      {!compact && SOURCE_META[source].short}
      {compact && <span className="sr-only">{SOURCE_META[source].label}</span>}
    </span>
  );
}

export function Legend({ sources = ['google_calendar', 'canvas', 'local'] as Source[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-3" aria-label="Source colors">
      {sources.map((s) => (
        <li key={s} className="inline-flex items-center gap-1.5 text-xs text-muted">
          <span
            aria-hidden
            className="size-2.5 rounded-sm"
            style={{ background: sourceColor(s) }}
          />
          {SOURCE_META[s].label}
        </li>
      ))}
    </ul>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'subtle' | 'danger';
  size?: 'sm' | 'md';
};

export function Button({
  variant = 'subtle',
  size = 'md',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-accent text-white hover:brightness-110',
        variant === 'subtle' && 'bg-surface-2 text-ink hover:bg-line',
        variant === 'ghost' && 'text-muted hover:bg-surface-2 hover:text-ink',
        variant === 'danger' && 'text-danger hover:bg-danger-soft',
        className,
      )}
      {...(rest as object)}
    >
      {children}
    </motion.button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted">
      {children}
    </kbd>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('skeleton rounded-md', className)} />;
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-2.5">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cx('h-10', i % 3 === 2 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  icon,
}: {
  title: string;
  hint?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line px-6 py-10 text-center"
    >
      {icon && <div className="text-faint">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-sm text-xs text-muted">{hint}</p>}
    </motion.div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm"
    >
      <TriangleAlert className="size-4 shrink-0 text-danger" aria-hidden />
      <span className="flex-1">
        {error instanceof Error ? error.message : 'Something went wrong.'}
      </span>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          <RefreshCw className="size-3.5" aria-hidden /> Retry
        </Button>
      )}
    </div>
  );
}

/** Animated on/off switch with a real checkbox role. */
export function Switch({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors',
          checked ? 'bg-accent' : 'bg-line',
        )}
      >
        <motion.span
          layout
          transition={{ type: 'spring', stiffness: 600, damping: 35 }}
          className={cx(
            'absolute top-1 size-4 rounded-full bg-white shadow',
            checked ? 'right-1' : 'left-1',
          )}
        />
      </button>
    </label>
  );
}

/** Segmented control with a sliding highlight. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  id,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  id: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'relative inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium',
            value === o.value ? 'text-ink' : 'text-muted hover:text-ink',
          )}
        >
          {value === o.value && (
            <motion.span
              layoutId={`seg-${id}`}
              className="absolute inset-0 rounded-md bg-surface shadow-card"
              transition={{ type: 'spring', stiffness: 500, damping: 38 }}
            />
          )}
          <span className="relative inline-flex items-center gap-1.5">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
