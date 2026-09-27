import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../src/lib/circuit-breaker.js';
import { HttpClient, HttpError, redact } from '../src/lib/http.js';
import { backoffWithJitter, parseRetryAfter, Throttle } from '../src/lib/rate-limit.js';
import { tmpStore } from './helpers.js';

function scripted(responses: Array<() => Response | Promise<Response>>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error('no more scripted responses');
    return next();
  }) as typeof fetch;
  return { impl, calls };
}

function client(fetchImpl: typeof fetch, sleeps: number[] = [], breaker?: CircuitBreaker) {
  return new HttpClient({
    rawStore: tmpStore(),
    userAgent: 'test',
    defaultDelayMs: 0,
    timeoutMs: 1000,
    maxRetries: 3,
    fetchImpl,
    breaker,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });
}

const opts = { source: 'test', kind: 'k', cacheClass: 'metadata' as const };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('HttpClient', () => {
  it('retries 429 honoring Retry-After, then succeeds', async () => {
    const sleeps: number[] = [];
    const { impl, calls } = scripted([json({ e: 1 }, 429, { 'retry-after': '2' }), json({ ok: true })]);
    const r = await client(impl, sleeps).getJson<{ ok: boolean }>('https://api.test/a', opts);
    expect(r.body.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
  });

  it('retries 5xx and network errors with backoff, then gives up', async () => {
    const sleeps: number[] = [];
    const { impl, calls } = scripted([json({}, 503), () => Promise.reject(new TypeError('socket hang up')), json({}, 502), json({}, 500)]);
    await expect(client(impl, sleeps).getJson('https://api.test/b', opts)).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
  });

  it('does not retry non-retryable errors, and treats 404 as a cacheable answer', async () => {
    const { impl, calls } = scripted([json({}, 400), json({ error: 'nf' }, 404)]);
    const c = client(impl);
    await expect(c.getJson('https://api.test/c', opts)).rejects.toBeInstanceOf(HttpError);
    const nf = await c.getJson('https://api.test/d', opts);
    expect(nf.status).toBe(404);
    expect(calls).toHaveLength(2);
  });

  it('stops immediately on an exhausted daily quota and opens the circuit', async () => {
    const { impl, calls } = scripted([json({ error: { message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'" } }, 429)]);
    const c = client(impl);
    await expect(c.getJson('https://quota.test/x', opts)).rejects.toBeInstanceOf(HttpError);
    await expect(c.getJson('https://quota.test/y', opts)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toHaveLength(1);
  });

  it('serves repeated requests from the raw-response cache', async () => {
    const { impl, calls } = scripted([json({ v: 1 })]);
    const c = client(impl);
    const a = await c.getJson('https://api.test/e', opts);
    const b = await c.getJson('https://api.test/e', opts);
    expect(a.fromCache).toBe(false);
    expect(b.fromCache).toBe(true);
    expect(b.body).toEqual({ v: 1 });
    expect(calls).toHaveLength(1);
  });

  it('never persists API keys in cached URLs', () => {
    expect(redact('https://www.googleapis.com/books/v1/volumes?q=x&key=SECRET123')).toBe('https://www.googleapis.com/books/v1/volumes?q=x&key=REDACTED');
  });
});

describe('rate limiting primitives', () => {
  it('spaces calls to the same key by the configured interval', async () => {
    let now = 0;
    const waits: number[] = [];
    const t = new Throttle(500, {}, () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    await t.acquire('h');
    await t.acquire('h');
    await t.acquire('other');
    expect(waits).toEqual([500]);
  });

  it('computes jittered exponential backoff and Retry-After', () => {
    expect(backoffWithJitter(0, 500, 30_000, () => 1)).toBe(500);
    expect(backoffWithJitter(3, 500, 30_000, () => 1)).toBe(4000);
    expect(backoffWithJitter(10, 500, 30_000, () => 1)).toBe(30_000);
    expect(backoffWithJitter(3, 500, 30_000, () => 0)).toBe(0);
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
  });

  it('opens, half-opens and closes the circuit', () => {
    let now = 0;
    const b = new CircuitBreaker(2, 1000, () => now);
    b.failure('h');
    expect(b.state('h')).toBe('closed');
    b.failure('h');
    expect(() => b.check('h')).toThrow(CircuitOpenError);
    now = 1500;
    expect(b.state('h')).toBe('half_open');
    b.success('h');
    expect(b.state('h')).toBe('closed');
  });
});
