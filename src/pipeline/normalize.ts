import type { SourceRecord } from '../domain/types.js';
import { readJsonl, requireFile, writeJsonl } from '../lib/jsonl.js';
import { log } from '../lib/logger.js';
import { recordRef } from '../normalize/merge.js';
import type { Runtime } from '../providers/registry.js';
import { providerByName } from '../providers/registry.js';
import type { FetchedItem } from '../providers/types.js';
import { files } from './context.js';

export interface NormalizeStats {
  items: number;
  records: number;
  work_records: number;
  edition_records: number;
  rejected_editions: number;
  records_with_warnings: number;
  empty_items: number;
}

/** NORMALIZATION + IDENTIFIER EXTRACTION + PRICE NORMALIZATION. Offline: reads raw files only. */
export function normalizeStage(rt: Runtime): NormalizeStats {
  const f = files(rt);
  requireFile(f.manifest, 'Run `npm run books:fetch` first.');
  const stats: NormalizeStats = { items: 0, records: 0, work_records: 0, edition_records: 0, rejected_editions: 0, records_with_warnings: 0, empty_items: 0 };
  const byRef = new Map<string, SourceRecord>();
  const rejected: unknown[] = [];
  const issues: unknown[] = [];

  for (const item of readJsonl<FetchedItem>(f.manifest)) {
    stats.items++;
    const provider = providerByName(rt, item.source);
    if (!provider) {
      log.warn('no provider for manifest item', { source: item.source });
      continue;
    }
    const out = provider.normalizeItem(item, rt.rawStore);
    if (out.records.length === 0) stats.empty_items++;
    for (const r of out.records) {
      const ref = recordRef(r);
      const prev = byRef.get(ref);
      if (prev) {
        // Same source record reached via several queries: keep one, union the discovery hits.
        for (const h of r.discovery) if (!prev.discovery.some((d) => d.query_id === h.query_id && d.source === h.source)) prev.discovery.push(h);
        continue;
      }
      byRef.set(ref, r);
    }
    for (const rj of out.rejected) {
      rejected.push({ reason: rj.reason, record_ref: recordRef(rj.record), title: rj.record.title, source_url: rj.record.source_url, item_key: item.item_key });
    }
  }
  for (const r of byRef.values()) {
    stats.records++;
    if (r.record_type === 'work') stats.work_records++;
    else stats.edition_records++;
    if (r.warnings.length) {
      stats.records_with_warnings++;
      issues.push({ record_ref: recordRef(r), title: r.title, warnings: r.warnings });
    }
  }
  stats.rejected_editions = rejected.length;
  writeJsonl(f.normalized, byRef.values());
  writeJsonl(f.normalizeRejected, rejected);
  writeJsonl(f.normalizeIssues, issues);
  return stats;
}
