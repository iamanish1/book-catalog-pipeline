/**
 * Per-key minimum-interval throttle. Calls for the same key are serialized so
 * that consecutive requests start at least `intervalMs` apart, even when
 * callers run concurrently.
 */
export class Throttle {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly last = new Map<string, number>();

  constructor(
    private readonly defaultIntervalMs: number,
    private readonly perKeyIntervalMs: Record<string, number> = {},
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  intervalFor(key: string): number {
    return this.perKeyIntervalMs[key] ?? this.defaultIntervalMs;
  }

  acquire(key: string): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      const last = this.last.get(key);
      const wait = last === undefined ? 0 : last + this.intervalFor(key) - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last.set(key, this.now());
    });
    this.chains.set(key, next.catch(() => undefined));
    return next;
  }
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Exponential backoff with "full jitter": random in [0, min(cap, base * 2^attempt)]. */
export function backoffWithJitter(attempt: number, baseMs = 500, capMs = 30_000, rand: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(rand() * ceiling);
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
