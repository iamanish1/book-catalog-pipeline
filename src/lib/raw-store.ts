import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Raw response store + cache.
 *
 * Every external response is written to data/raw/<source>/<kind>/<hash>.json
 * together with request metadata. The same files act as the HTTP cache (TTL per
 * cache class), so the pipeline can be re-run and re-normalized offline without
 * re-requesting external APIs.
 */
export type CacheClass = 'metadata' | 'price' | 'image';

export interface RawEnvelope<T = unknown> {
  source: string;
  kind: string;
  cache_class: CacheClass;
  /** Logical cache key (e.g. "isbn:9780857197689", "query:subject:fantasy"). */
  cache_key: string;
  url: string;
  method: string;
  status: number;
  fetched_at: string;
  body: T;
}

export function sha1(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex');
}

export class RawStore {
  constructor(
    readonly rootDir: string,
    private readonly ttlMs: Record<CacheClass, number>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Path relative to rootDir; stored in records as provenance (`raw_ref`). */
  refFor(source: string, kind: string, cacheKey: string): string {
    return path.posix.join(source, kind, `${sha1(cacheKey)}.json`);
  }

  absolute(ref: string): string {
    return path.join(this.rootDir, ...ref.split('/'));
  }

  read<T = unknown>(ref: string): RawEnvelope<T> | null {
    const file = this.absolute(ref);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RawEnvelope<T>;
  }

  /** Returns a cached envelope if present and fresh for its cache class. */
  getFresh<T = unknown>(ref: string, cacheClass: CacheClass): RawEnvelope<T> | null {
    const env = this.read<T>(ref);
    if (!env) return null;
    const age = this.now() - Date.parse(env.fetched_at);
    return age <= this.ttlMs[cacheClass] ? env : null;
  }

  write(ref: string, env: RawEnvelope): void {
    const file = this.absolute(ref);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(env));
    fs.renameSync(tmp, file);
  }
}
