import type { MergedWork } from '../domain/types.js';
import { readJsonl, requireFile, writeJsonl } from '../lib/jsonl.js';
import { checkImage } from '../normalize/image.js';
import { Taxonomy } from '../normalize/taxonomy.js';
import type { Runtime } from '../providers/registry.js';
import type { ValidationOutcome } from '../validation/validate.js';
import { flagProbableDuplicates, validateWork } from '../validation/validate.js';
import { files } from './context.js';

export interface ValidateStats {
  works: number;
  valid: number;
  quarantined: number;
  probable_duplicates: number;
  images_checked: number;
  images_unreachable: number;
  errors_by_code: Record<string, number>;
  warnings_by_code: Record<string, number>;
}

/** Mark image reachability (HEAD, cached). Mode "primary" checks the first edition's front cover of each work. */
export async function validateImages(rt: Runtime, works: MergedWork[]): Promise<{ checked: number; unreachable: number }> {
  let checked = 0;
  let unreachable = 0;
  if (rt.env.imageValidation === 'none') return { checked, unreachable };
  for (const w of works) {
    const eds = rt.env.imageValidation === 'all' ? w.editions : w.editions.slice(0, 1);
    for (const e of eds) {
      const img = e.images.find((i) => i.kind === 'front');
      if (!img) continue;
      const r = await checkImage(rt.http, img.url);
      img.reachable = r.reachable;
      img.content_type = r.content_type && r.content_type.length < 60 ? r.content_type : null;
      checked++;
      if (!r.reachable) unreachable++;
    }
  }
  return { checked, unreachable };
}

/** IMAGE VALIDATION + QUALITY VALIDATION. Invalid records go to data/quarantine/. */
export async function validateStage(rt: Runtime): Promise<ValidateStats> {
  const f = files(rt);
  requireFile(f.works, 'Run `npm run books:dedupe` first.');
  const works = [...readJsonl<MergedWork>(f.works)];
  const img = await validateImages(rt, works);
  const taxonomy = new Taxonomy(rt.config.taxonomy);
  const outcomes: ValidationOutcome[] = works.map((w) => validateWork(w, taxonomy));
  flagProbableDuplicates(outcomes, rt.env.duplicateQuarantineThreshold);

  const stats: ValidateStats = {
    works: works.length,
    valid: 0,
    quarantined: 0,
    probable_duplicates: 0,
    images_checked: img.checked,
    images_unreachable: img.unreachable,
    errors_by_code: {},
    warnings_by_code: {},
  };
  for (const o of outcomes) {
    if (o.valid) stats.valid++;
    else stats.quarantined++;
    for (const i of o.issues) {
      const bucket = i.severity === 'error' ? stats.errors_by_code : stats.warnings_by_code;
      bucket[i.code] = (bucket[i.code] ?? 0) + 1;
      if (i.code === 'probable_duplicate') stats.probable_duplicates++;
    }
  }
  writeJsonl(f.validated, outcomes.filter((o) => o.valid).map((o) => o.work));
  writeJsonl(
    f.quarantined,
    outcomes.filter((o) => !o.valid).map((o) => ({ key: o.work.key, title: o.work.title, issues: o.issues, record: o.work })),
  );
  writeJsonl(
    f.qualityIssues,
    outcomes.filter((o) => o.issues.length).map((o) => ({ key: o.work.key, title: o.work.title, valid: o.valid, issues: o.issues })),
  );
  return stats;
}
