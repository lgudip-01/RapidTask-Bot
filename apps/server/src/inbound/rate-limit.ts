/** Sliding-window limiter keyed by sender (in memory; single process). */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns whether it is within the limit. */
  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    const ok = recent.length < this.limit;
    if (ok) recent.push(t);
    this.hits.set(key, recent);
    return ok;
  }
}

/** Emits at most one log call per key per interval, reporting how many were suppressed. */
export class LogThrottle {
  private readonly last = new Map<string, { at: number; suppressed: number }>();

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns the suppressed count to log now, or null if this occurrence should stay silent. */
  hit(key: string): number | null {
    const t = this.now();
    const s = this.last.get(key);
    if (s && t - s.at < this.intervalMs) {
      s.suppressed++;
      return null;
    }
    this.last.set(key, { at: t, suppressed: 0 });
    return s?.suppressed ?? 0;
  }
}
