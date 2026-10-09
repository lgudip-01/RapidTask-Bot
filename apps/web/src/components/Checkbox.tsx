import { motion } from 'motion/react';
import { cx } from './ui';

/** Round checkbox that draws its check mark. Uses role=checkbox for screen readers. */
export function Checkbox({
  checked,
  onChange,
  label,
  color,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  color?: string;
}) {
  return (
    <motion.button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      whileTap={{ scale: 0.85 }}
      whileHover={{ scale: 1.08 }}
      className={cx(
        'grid size-[18px] shrink-0 place-items-center rounded-full border-[1.5px] transition-colors',
        checked ? 'border-transparent' : 'border-faint hover:border-ink',
      )}
      style={checked ? { background: color ?? 'var(--accent)' } : undefined}
    >
      <svg viewBox="0 0 16 16" className="size-3" aria-hidden>
        <motion.path
          d="M3.5 8.5l3 3 6-7"
          fill="none"
          stroke="white"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={false}
          animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        />
      </svg>
    </motion.button>
  );
}
