import type { CatalogRepository } from '../db/repository.js';
import type { MergedWork, QualityIssue } from '../domain/types.js';
import { readJsonl, requireFile } from '../lib/jsonl.js';
import { log } from '../lib/logger.js';
import type { Runtime } from '../providers/registry.js';
import { files } from './context.js';

export interface ImportOptions {
  /** Import at most N works, chosen round-robin across discovery queries (most popular first within each) to keep category coverage. */
  limit?: number;
}

export interface ImportStats {
  candidates: number;
  selected: number;
  inserted: number;
  updated: number;
  failed: number;
  editions_inserted: number;
  editions_updated: number;
  prices_changed: number;
  merge_conflicts: number;
  matched_existing_by: Record<string, number>;
  quality_issues_recorded: number;
}

/** DATABASE UPSERT in batches (BOOK_IMPORT_BATCH_SIZE per transaction). */
export function importStage(rt: Runtime, repo: CatalogRepository, jobId: string, opts: ImportOptions = {}): ImportStats {
  const f = files(rt);
  requireFile(f.validated, 'Run `npm run books:validate` first.');
  let works = [...readJsonl<MergedWork>(f.validated)];
  const candidates = works.length;
  if (opts.limit !== undefined && works.length > opts.limit) works = stratifiedSelection(works, opts.limit);
  const selectedKeys = new Set(works.map((w) => w.key));
  const stats: ImportStats = {
    candidates,
    selected: works.length,
    inserted: 0,
    updated: 0,
    failed: 0,
    editions_inserted: 0,
    editions_updated: 0,
    prices_changed: 0,
    merge_conflicts: 0,
    matched_existing_by: {},
    quality_issues_recorded: 0,
  };
  const batch = Math.max(1, rt.env.batchSize);
  for (let i = 0; i < works.length; i += batch) {
    const chunk = works.slice(i, i + batch);
    repo.transaction(() => {
      for (const w of chunk) {
        try {
          const r = repo.upsertWork(w, jobId);
          if (r.action === 'inserted') stats.inserted++;
          else stats.updated++;
          if (r.matched_by) stats.matched_existing_by[r.matched_by] = (stats.matched_existing_by[r.matched_by] ?? 0) + 1;
          stats.editions_inserted += r.editions_inserted;
          stats.editions_updated += r.editions_updated;
          stats.prices_changed += r.prices_changed;
          stats.merge_conflicts += r.conflicts.length;
        } catch (e) {
          stats.failed++;
          log.error('import failed for work', { job_id: jobId, key: w.key, title: w.title, error: String(e) });
          repo.recordQualityIssues(jobId, 'import', w.key, w.title, [{ field: 'record', code: 'import_failed', message: String(e), severity: 'error' }]);
        }
      }
    });
    log.info('import.batch', { job_id: jobId, done: Math.min(i + batch, works.length), total: works.length });
  }

  // Persist quality findings from validate (and normalize warnings) for the dashboard.
  repo.transaction(() => {
    for (const q of readJsonl<{ key: string; title: string; valid: boolean; issues: QualityIssue[] }>(f.qualityIssues)) {
      if (q.valid && !selectedKeys.has(q.key)) continue;
      repo.recordQualityIssues(jobId, 'validate', q.key, q.title, q.issues);
      stats.quality_issues_recorded += q.issues.length;
    }
    for (const n of readJsonl<{ record_ref: string; title: string; warnings: string[] }>(f.normalizeIssues)) {
      const issues = n.warnings.map((w): QualityIssue => ({ field: 'source_record', code: w.split(':')[0]!, message: w, severity: 'warning' }));
      repo.recordQualityIssues(jobId, 'normalize', n.record_ref, n.title, issues);
      stats.quality_issues_recorded += issues.length;
    }
    for (const r of readJsonl<{ reason: string; record_ref: string; title: string }>(f.normalizeRejected)) {
      repo.recordQualityIssues(jobId, 'normalize', r.record_ref, r.title, [
        { field: 'edition', code: r.reason.split(':')[0]!, message: `edition excluded: ${r.reason}`, severity: 'warning' },
      ]);
      stats.quality_issues_recorded++;
    }
  });
  return stats;
}

/** Round-robin over each work's best discovery query so a size cap does not drop whole categories. */
export function stratifiedSelection(works: MergedWork[], limit: number): MergedWork[] {
  const byQuery = new Map<string, MergedWork[]>();
  for (const w of works) {
    const best = [...w.discovery].sort((a, b) => a.rank - b.rank)[0];
    const k = best?.query_id ?? '~none';
    byQuery.set(k, [...(byQuery.get(k) ?? []), w]);
  }
  const queues = [...byQuery.values()].map((q) => q.sort((a, b) => (b.popularity.score ?? -1) - (a.popularity.score ?? -1)));
  const out: MergedWork[] = [];
  for (let round = 0; out.length < limit; round++) {
    let took = false;
    for (const q of queues) {
      const w = q[round];
      if (w && out.length < limit) {
        out.push(w);
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}
