import type { CatalogRepository } from '../db/repository.js';
import type { BookDto, SourceRecord } from '../domain/types.js';
import { toIsbn13 } from '../lib/isbn.js';
import { log } from '../lib/logger.js';
import { dedupe } from '../matching/dedupe.js';
import { buildContext, buildMergedWork } from '../normalize/work-builder.js';
import { Taxonomy } from '../normalize/taxonomy.js';
import type { Runtime } from '../providers/registry.js';
import { validateWork } from '../validation/validate.js';
import { newJobId, runStage } from './context.js';
import { dedupeStage } from './dedupe.js';
import type { DiscoverOptions } from './discover.js';
import { discover } from './discover.js';
import { fetchStage } from './fetch.js';
import { importStage } from './import.js';
import { normalizeStage } from './normalize.js';
import { validateImages, validateStage } from './validate.js';

export interface SyncOptions extends DiscoverOptions {
  /** Skip network stages and reprocess stored raw data only. */
  offline?: boolean;
}

export interface SyncSummary {
  job_id: string;
  fetched: number;
  normalized: number;
  duplicates: number;
  valid: number;
  invalid: number;
  inserted: number;
  updated: number;
  failed: number;
  started_at: string;
  completed_at: string;
  stages: Record<string, unknown>;
}

/** Full pipeline: DISCOVERY → FETCH → NORMALIZE → DEDUPE → VALIDATE → IMPORT. */
export async function runSync(rt: Runtime, repo: CatalogRepository, opts: SyncOptions = {}, jobId = newJobId()): Promise<SyncSummary> {
  const started_at = new Date().toISOString();
  repo.startJob(jobId, 'sync', { ...opts });
  try {
    const stages: Record<string, unknown> = {};
    let fetched = 0;
    if (!opts.offline) {
      stages.discover = (await runStage(rt, 'discover', jobId, () => discover(rt, opts).stats)).stats;
      const f = await runStage(rt, 'fetch', jobId, () => fetchStage(rt, jobId));
      stages.fetch = f.stats;
      fetched = f.stats.discovered + f.stats.enrichment_items;
    }
    const n = await runStage(rt, 'normalize', jobId, () => normalizeStage(rt));
    const d = await runStage(rt, 'dedupe', jobId, () => dedupeStage(rt));
    const v = await runStage(rt, 'validate', jobId, () => validateStage(rt));
    const i = await runStage(rt, 'import', jobId, () => importStage(rt, repo, jobId, { limit: opts.target }));
    Object.assign(stages, { normalize: n.stats, dedupe: d.stats, validate: v.stats, import: i.stats });
    const summary: SyncSummary = {
      job_id: jobId,
      fetched: fetched || n.stats.items,
      normalized: n.stats.records,
      duplicates: d.stats.edition_duplicates_merged + d.stats.work_duplicates_merged + v.stats.probable_duplicates + i.stats.updated,
      valid: v.stats.valid,
      invalid: v.stats.quarantined,
      inserted: i.stats.inserted,
      updated: i.stats.updated,
      failed: i.stats.failed,
      started_at,
      completed_at: new Date().toISOString(),
      stages,
    };
    repo.finishJob(jobId, 'completed', summary as unknown as Record<string, unknown>);
    log.info('sync.summary', { ...summary, stages: undefined });
    return summary;
  } catch (e) {
    repo.finishJob(jobId, 'failed', {}, String(e));
    throw e;
  }
}

export interface IsbnImportResult {
  job_id: string;
  isbn_13: string;
  status: 'imported' | 'not_found' | 'quarantined';
  sources: string[];
  book: BookDto | null;
  issues: Array<{ code: string; message: string; severity: string }>;
}

/** Import a single ISBN on demand from every enabled provider (same normalize/dedupe/validate rules). */
export async function importIsbn(rt: Runtime, repo: CatalogRepository, rawIsbn: string): Promise<IsbnImportResult> {
  const isbn13 = toIsbn13(rawIsbn);
  if (!isbn13) throw new Error(`Invalid ISBN: ${rawIsbn}`);
  const jobId = newJobId();
  repo.startJob(jobId, 'isbn', { isbn: isbn13 });
  try {
    const records: SourceRecord[] = [];
    const sources: string[] = [];
    for (const p of rt.providers.filter((x) => x.isEnabled())) {
      try {
        const book = await p.getBookByISBN(isbn13);
        if (!book) continue;
        sources.push(p.name);
        if (book.work) records.push(book.work);
        records.push(...book.editions);
      } catch (e) {
        log.warn('isbn lookup failed', { job_id: jobId, source: p.name, isbn: isbn13, error: String(e) });
      }
    }
    if (!records.some((r) => r.record_type === 'edition' && r.isbn_13 === isbn13)) {
      repo.finishJob(jobId, 'completed', { status: 'not_found', sources });
      return { job_id: jobId, isbn_13: isbn13, status: 'not_found', sources, book: null, issues: [] };
    }
    const { groups } = dedupe(records);
    const ctx = buildContext(rt.config);
    const group = groups.find((g) => g.editionClusters.some((c) => c.some((e) => e.isbn_13 === isbn13)))!;
    const work = buildMergedWork(group, ctx);
    await validateImages(rt, [work]);
    const outcome = validateWork(work, new Taxonomy(rt.config.taxonomy));
    repo.recordQualityIssues(jobId, 'isbn_import', work.key, work.title, outcome.issues);
    const issues = outcome.issues.map((i) => ({ code: i.code, message: i.message, severity: i.severity }));
    if (!outcome.valid) {
      repo.finishJob(jobId, 'completed', { status: 'quarantined', sources, issues });
      return { job_id: jobId, isbn_13: isbn13, status: 'quarantined', sources, book: null, issues };
    }
    const r = repo.upsertWork(outcome.work, jobId);
    repo.finishJob(jobId, 'completed', { status: 'imported', sources, ...r });
    return { job_id: jobId, isbn_13: isbn13, status: 'imported', sources, book: repo.getBookByIsbn(isbn13), issues };
  } catch (e) {
    repo.finishJob(jobId, 'failed', {}, String(e));
    throw e;
  }
}
