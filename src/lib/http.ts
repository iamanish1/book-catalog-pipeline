import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
import { log } from './logger.js';
import { backoffWithJitter, defaultSleep, parseRetryAfter, Throttle } from './rate-limit.js';
import type { CacheClass, RawEnvelope, RawStore } from './raw-store.js';
import { sha1 } from './raw-store.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodySnippet: string,
  ) {
    super(`HTTP ${status} for ${redact(url)}`);
    this.name = 'HttpError';
  }
}

export interface RequestOptions {
  source: string;
  kind: string;
  cacheClass: CacheClass;
  /** Logical cache key. Defaults to method + URL (+ body hash). */
  cacheKey?: string;
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** Statuses that are valid, cacheable answers (e.g. 404 = "not found"). */
  acceptStatuses?: number[];
  /** Bypass cache read (still writes). */
  refresh?: boolean;
}

export interface HttpResult<T> {
  status: number;
  body: T;
  ref: string;
  fromCache: boolean;
  fetchedAt: string;
}

export interface HttpClientOptions {
  rawStore: RawStore;
  userAgent: string;
  defaultDelayMs: number;
  perHostDelayMs?: Record<string, number>;
  timeoutMs: number;
  maxRetries: number;
  /** Upper bound for honoring a Retry-After header; longer waits fail and trip the breaker. */
  maxRetryAfterMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  breaker?: CircuitBreaker;
  random?: () => number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Remove credentials from URLs before logging or persisting them. */
export function redact(url: string): string {
  return url.replace(/([?&](?:key|api_key|apikey|access_key|token)=)[^&]+/gi, '$1REDACTED');
}

/**
 * Polite HTTP client: per-host throttling, timeouts, retries with exponential
 * backoff + jitter, Retry-After/429 handling, per-host circuit breaker, and
 * raw-response caching. It never attempts to evade rate limits: when a source
 * says "slow down" or "quota exhausted" we wait or stop.
 */
export class HttpClient {
  readonly throttle: Throttle;
  readonly breaker: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  readonly stats = { requests: 0, cacheHits: 0, retries: 0, failures: 0 };

  constructor(private readonly opts: HttpClientOptions) {
    this.throttle = new Throttle(opts.defaultDelayMs, opts.perHostDelayMs ?? {});
    this.breaker = opts.breaker ?? new CircuitBreaker(5, 60_000);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
  }

  get rawStore(): RawStore {
    return this.opts.rawStore;
  }

  async getJson<T = unknown>(url: string, o: RequestOptions): Promise<HttpResult<T>> {
    const method = o.method ?? 'GET';
    const cacheKey = o.cacheKey ?? `${method} ${url}${o.body ? ` ${sha1(o.body)}` : ''}`;
    const ref = this.opts.rawStore.refFor(o.source, o.kind, cacheKey);
    if (!o.refresh) {
      const cached = this.opts.rawStore.getFresh<T>(ref, o.cacheClass);
      if (cached) {
        this.stats.cacheHits++;
        return { status: cached.status, body: cached.body, ref, fromCache: true, fetchedAt: cached.fetched_at };
      }
    }
    const res = await this.request(url, o);
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const fetchedAt = new Date().toISOString();
    const env: RawEnvelope = {
      source: o.source,
      kind: o.kind,
      cache_class: o.cacheClass,
      cache_key: cacheKey,
      url: redact(url),
      method,
      status: res.status,
      fetched_at: fetchedAt,
      body,
    };
    this.opts.rawStore.write(ref, env);
    return { status: res.status, body: body as T, ref, fromCache: false, fetchedAt };
  }

  /** Text fetch without JSON parsing (HTML pages, robots.txt). Cached the same way. */
  async getText(url: string, o: RequestOptions): Promise<HttpResult<string>> {
    const r = await this.getJson<unknown>(url, o);
    return { ...r, body: typeof r.body === 'string' ? r.body : r.body === null ? '' : JSON.stringify(r.body) };
  }

  /** Low-level request with throttle/retry/breaker. Returns only accepted responses. */
  async request(url: string, o: RequestOptions): Promise<Response> {
    const host = new URL(url).host;
    const accept = new Set([...(o.acceptStatuses ?? [404])]);
    const maxRetryAfter = this.opts.maxRetryAfterMs ?? 120_000;
    let attempt = 0;
    for (;;) {
      this.breaker.check(host);
      await this.throttle.acquire(host);
      this.stats.requests++;
      let res: Response | null = null;
      let err: unknown = null;
      try {
        res = await this.fetchImpl(url, {
          method: o.method ?? 'GET',
          headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/json', ...o.headers },
          body: o.body,
          redirect: 'follow',
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (e) {
        err = e;
      }

      if (res && (res.ok || accept.has(res.status))) {
        this.breaker.success(host);
        return res;
      }

      const status = res?.status ?? 0;
      const snippet = res ? (await res.text().catch(() => '')).slice(0, 500) : String(err);
      if (res && status === 429 && /per day|daily|quota/i.test(snippet) && !/per minute/i.test(snippet)) {
        // Daily quota exhausted: retrying cannot help. Stop calling this host for a long time.
        this.breaker.trip(host, 6 * 3_600_000);
        this.stats.failures++;
        log.warn('daily quota exhausted; circuit opened', { host, status });
        throw new HttpError(status, url, snippet);
      }
      const retryable = !res || RETRYABLE.has(status);
      if (!retryable || attempt >= this.opts.maxRetries) {
        this.breaker.failure(host);
        this.stats.failures++;
        if (!res) throw err instanceof Error ? err : new Error(String(err));
        throw new HttpError(status, url, snippet);
      }
      let delay = backoffWithJitter(attempt, 500, 30_000, this.random);
      const retryAfter = res ? parseRetryAfter(res.headers.get('retry-after')) : null;
      if (retryAfter !== null) {
        if (retryAfter > maxRetryAfter) {
          this.breaker.trip(host, retryAfter);
          this.stats.failures++;
          throw new HttpError(status, url, `Retry-After ${retryAfter}ms exceeds limit`);
        }
        delay = Math.max(delay, retryAfter);
      }
      this.stats.retries++;
      log.debug('retrying request', { host, status, attempt, delay_ms: delay, error: err ? String(err) : undefined });
      attempt++;
      await this.sleep(delay);
    }
  }
}

export { CircuitOpenError };
