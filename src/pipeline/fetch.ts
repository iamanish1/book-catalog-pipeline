import fs from 'node:fs';
import type { EditionSourceRecord } from '../domain/types.js';
import { appendJsonl, requireFile, writeJsonl } from '../lib/jsonl.js';
import { log } from '../lib/logger.js';
import type { Runtime } from '../providers/registry.js';
import type { BookDataProvider, FetchedItem } from '../providers/types.js';
import { files } from './context.js';
import type { DiscoveryPlan } from './discover.js';

export interface FetchOptions {
  /** Optional hard stop after this many distinct discovery items (per-query limits from the plan already bound the run). */
  maxItems?: number;
  /** ISBNs per discovered work to enrich via other providers (Google Books, Amazon, publishers). */
  enrichEditionsPerWork?: number;
}

export interface FetchStats {
  queries: number;
  discovered: number;
  enrichment_items: number;
  failed_queries: number;
  failed_enrichments: number;
  http_requests: number;
  cache_hits: number;
  retries: number;
  per_source: Record<string, number>;
}

/** FETCH: run discovery queries against providers, enrich by ISBN, store raw responses + a manifest. */
export async function fetchStage(rt: Runtime, jobId: string, opts: FetchOptions = {}): Promise<FetchStats> {
  const f = files(rt);
  requireFile(f.plan, 'Run `npm run books:discover` first.');
  const plan = JSON.parse(fs.readFileSync(f.plan, 'utf8')) as DiscoveryPlan;
  const enabled = rt.providers.filter((p) => p.isEnabled());
  const discoverers = enabled.filter((p) => p.discover);
  const enrichers = enabled.filter((p) => p.enrichByIsbn);
  const maxItems = opts.maxItems ?? Infinity;
  const perWork = opts.enrichEditionsPerWork ?? 1;

  const items: FetchedItem[] = [];
  const seen = new Set<string>();
  const enrichedIsbns = new Set<string>();
  const stats: FetchStats = {
    queries: 0,
    discovered: 0,
    enrichment_items: 0,
    failed_queries: 0,
    failed_enrichments: 0,
    http_requests: 0,
    cache_hits: 0,
    retries: 0,
    per_source: {},
  };
  const before = { ...rt.http.stats };

  const enrich = async (isbns: EditionSourceRecord[], skip: BookDataProvider, queryId: string) => {
    for (const ed of isbns) {
      if (!ed.isbn_13 || enrichedIsbns.has(ed.isbn_13)) continue;
      enrichedIsbns.add(ed.isbn_13);
      for (const p of enrichers) {
        if (p === skip) continue;
        try {
          const got = await p.enrichByIsbn!({ isbn_13: ed.isbn_13, isbn_10: ed.isbn_10 }, queryId);
          for (const it of got) {
            items.push(it);
            stats.enrichment_items++;
            stats.per_source[p.name] = (stats.per_source[p.name] ?? 0) + 1;
          }
        } catch (e) {
          stats.failed_enrichments++;
          log.warn('enrichment failed', { job_id: jobId, source: p.name, isbn: ed.isbn_13, error: String(e) });
        }
      }
    }
  };

  // Per-query limits come from the plan (target spread across all queries), so a small target still covers every category.
  outer: for (const q of plan.queries) {
    for (const p of discoverers) {
      if (seen.size >= maxItems) break outer;
      stats.queries++;
      const startedAt = new Date().toISOString();
      let fetched = 0;
      let failed = 0;
      try {
        const found = await p.discover!(q);
        for (const it of found) {
          const key = `${it.source}:${it.item_key}`;
          // The same work found by another query: keep the extra discovery hit (it is a popularity/category signal).
          items.push(it);
          if (seen.has(key)) continue;
          seen.add(key);
          fetched++;
          stats.discovered++;
          stats.per_source[p.name] = (stats.per_source[p.name] ?? 0) + 1;
          if (enrichers.length > 1 && perWork > 0) {
            const recs = p.normalizeItem(it, rt.rawStore).records.filter((r): r is EditionSourceRecord => r.record_type === 'edition');
            await enrich(recs.slice(0, perWork), p, q.id);
          }
          if (seen.size >= maxItems) break;
        }
      } catch (e) {
        failed++;
        stats.failed_queries++;
        log.warn('discovery query failed', { job_id: jobId, source: p.name, query: q.id, error: String(e) });
      }
      const line = { job_id: jobId, stage: 'fetch', source: p.name, query: q.id, fetched, failed, started_at: startedAt, completed_at: new Date().toISOString() };
      appendJsonl(f.jobsLog, line);
      log.info('fetch.query', line);
    }
  }

  writeJsonl(f.manifest, items);
  stats.http_requests = rt.http.stats.requests - before.requests;
  stats.cache_hits = rt.http.stats.cacheHits - before.cacheHits;
  stats.retries = rt.http.stats.retries - before.retries;
  return stats;
}
