/**
 * Consecutive-failure circuit breaker. After `threshold` consecutive failures
 * the circuit opens and calls fail fast until `cooldownMs` elapses; then one
 * trial call is allowed (half-open). Success closes the circuit.
 */
export type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitOpenError extends Error {
  constructor(
    readonly key: string,
    readonly retryAt: number,
  ) {
    super(`Circuit open for ${key} until ${new Date(retryAt).toISOString()}`);
    this.name = 'CircuitOpenError';
  }
}

interface Entry {
  failures: number;
  openedUntil: number;
  state: CircuitState;
}

export class CircuitBreaker {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { failures: 0, openedUntil: 0, state: 'closed' };
      this.entries.set(key, e);
    }
    return e;
  }

  state(key: string): CircuitState {
    const e = this.entry(key);
    if (e.state === 'open' && this.now() >= e.openedUntil) e.state = 'half_open';
    return e.state;
  }

  /** Throws CircuitOpenError if calls to `key` should not be attempted now. */
  check(key: string): void {
    const s = this.state(key);
    if (s === 'open') throw new CircuitOpenError(key, this.entry(key).openedUntil);
  }

  success(key: string): void {
    const e = this.entry(key);
    e.failures = 0;
    e.state = 'closed';
  }

  failure(key: string): void {
    const e = this.entry(key);
    e.failures++;
    if (e.state === 'half_open' || e.failures >= this.threshold) this.trip(key, this.cooldownMs);
  }

  /** Open immediately, e.g. when a source reports an exhausted daily quota. */
  trip(key: string, forMs: number): void {
    const e = this.entry(key);
    e.state = 'open';
    e.openedUntil = this.now() + forMs;
  }
}
