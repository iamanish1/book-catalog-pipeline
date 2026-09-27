import type { SourceRecord } from '../domain/types.js';
import { readJsonl, requireFile, writeJsonl } from '../lib/jsonl.js';
import type { DedupeStats } from '../matching/dedupe.js';
import { dedupe } from '../matching/dedupe.js';
import { buildContext, buildMergedWork } from '../normalize/work-builder.js';
import type { Runtime } from '../providers/registry.js';
import { files } from './context.js';

export interface DedupeStageStats extends DedupeStats {
  classified: number;
  unclassified: number;
  with_popularity: number;
  conflicts: number;
}

/** DEDUPLICATION + EDITION MATCHING + FIELD MERGE + CATEGORY/GENRE/TAG NORMALIZATION + POPULARITY. */
export function dedupeStage(rt: Runtime): DedupeStageStats {
  const f = files(rt);
  requireFile(f.normalized, 'Run `npm run books:normalize` first.');
  const records = [...readJsonl<SourceRecord>(f.normalized)];
  const { groups, stats } = dedupe(records);
  const ctx = buildContext(rt.config);
  const works = groups.map((g) => buildMergedWork(g, ctx));
  writeJsonl(f.works, works);
  return {
    ...stats,
    classified: works.filter((w) => w.category).length,
    unclassified: works.filter((w) => !w.category).length,
    with_popularity: works.filter((w) => w.popularity.score !== null).length,
    conflicts: works.reduce((s, w) => s + w.conflicts.length + w.editions.reduce((t, e) => t + e.conflicts.length, 0), 0),
  };
}
