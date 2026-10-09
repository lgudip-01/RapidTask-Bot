import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ListTodo, Search } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { api } from '../lib/api';
import { useDebounced } from '../lib/hooks';
import { fmtDay, fmtTime } from '../lib/time';
import { Dialog } from './Dialog';
import { SourceBadge } from './ui';

export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 200);
  const res = useQuery({
    queryKey: ['search', term],
    queryFn: () => api.search(term),
    enabled: open && term.length > 0,
  });

  return (
    <Dialog open={open} onClose={onClose} label="Search">
      <div className="flex items-center gap-2 border-b border-line px-4 focus-within:border-accent">
        <Search className="size-4 text-faint" aria-hidden />
        <label htmlFor="search-input" className="sr-only">
          Search tasks and events
        </label>
        <input
          id="search-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tasks and events…"
          className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-faint focus-visible:outline-none"
          autoComplete="off"
        />
      </div>
      <div className="max-h-[50vh] overflow-y-auto p-2 scrollbar-thin">
        {!term && (
          <p className="px-3 py-6 text-center text-xs text-muted">Type to search titles.</p>
        )}
        {term && res.isLoading && (
          <p className="px-3 py-6 text-center text-xs text-muted">Searching…</p>
        )}
        {term && res.data && res.data.items.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted">No matches for “{term}”.</p>
        )}
        <ul>
          {res.data?.items.map((i, idx) => (
            <motion.li
              key={`${i.kind}-${i.item.id}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.015 }}
              className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-surface-2"
            >
              {i.kind === 'event' ? (
                <CalendarDays className="size-4 text-faint" aria-hidden />
              ) : (
                <ListTodo className="size-4 text-faint" aria-hidden />
              )}
              <span className="flex-1 truncate text-sm">{i.item.title}</span>
              <span className="text-xs text-muted">
                {i.kind === 'event'
                  ? `${fmtDay(i.item.start)}${i.item.allDay ? '' : `, ${fmtTime(i.item.start)}`}`
                  : i.item.due
                    ? `due ${fmtDay(i.item.due)}`
                    : i.item.status}
              </span>
              <SourceBadge source={i.item.source} compact />
            </motion.li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
