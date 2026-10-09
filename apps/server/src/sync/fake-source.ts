import type { Source } from '@planner/shared';
import type { SyncBatch, SyncItem, SyncSource } from './types';

/** JSON shape of a fixture page: like SyncBatch, but dates are ISO strings. */
export interface FixturePage {
  items: unknown[];
  fullResync?: boolean;
}

const DATE_KEYS = ['start', 'end', 'due', 'updatedAt', 'createdAt', 'completedAt'] as const;

function revive(item: unknown): SyncItem {
  const it = structuredClone(item) as { kind: string; data?: Record<string, unknown> };
  if (it.data) {
    for (const k of DATE_KEYS) {
      const v = it.data[k];
      if (typeof v === 'string') it.data[k] = new Date(v);
    }
  }
  return it as SyncItem;
}

/**
 * Replays fixture pages. The cursor is the index of the next page; once past the end it keeps
 * returning empty batches. `failOn` lists page indexes that throw instead.
 */
export class FakeSource implements SyncSource {
  calls = 0;

  constructor(
    public readonly name: string,
    private readonly pages: FixturePage[],
    public readonly owns: { events: Source[]; tasks: Source[] },
    public readonly intervalMs = 60_000,
    public failOn: Set<number> = new Set(),
  ) {}

  async fetchSince(cursor: string | null): Promise<SyncBatch> {
    this.calls++;
    const i = cursor === null ? 0 : Number(cursor);
    if (this.failOn.has(i)) {
      throw new Error(`fake upstream 503 (Authorization: Bearer fake-secret-token) on page ${i}`);
    }
    const page = this.pages[i];
    if (!page) return { items: [], nextCursor: String(i) };
    return {
      items: page.items.map(revive),
      fullResync: page.fullResync,
      nextCursor: String(i + 1),
    };
  }
}
