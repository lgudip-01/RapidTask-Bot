export interface Segment<T> {
  item: T;
  /** Minutes from local midnight. */
  start: number;
  end: number;
}

export interface Placed<T> extends Segment<T> {
  col: number;
  cols: number;
}

/**
 * Side-by-side layout for overlapping timed events in one day column: events that overlap form
 * a cluster; each gets the first free column; all events in a cluster share the column count.
 */
export function layoutDay<T>(segments: Segment<T>[], minDuration = 20): Placed<T>[] {
  const sorted = [...segments]
    .map((s) => ({ ...s, end: Math.max(s.end, s.start + minDuration) }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Placed<T>[] = [];
  let cluster: Placed<T>[] = [];
  let clusterEnd = -1;
  let colEnds: number[] = [];

  const flush = () => {
    const cols = colEnds.length;
    for (const p of cluster) p.cols = cols;
    out.push(...cluster);
    cluster = [];
    colEnds = [];
  };

  for (const s of sorted) {
    if (cluster.length && s.start >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= s.start);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(s.end);
    } else {
      colEnds[col] = s.end;
    }
    cluster.push({ ...s, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, s.end);
  }
  if (cluster.length) flush();
  return out;
}
