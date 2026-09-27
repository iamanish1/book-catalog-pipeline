import crypto from 'node:crypto';
import path from 'node:path';
import { appendJsonl } from '../lib/jsonl.js';
import { log } from '../lib/logger.js';
import type { Runtime } from '../providers/registry.js';

export interface StageResult<S extends object = Record<string, unknown>> {
  job_id: string;
  stage: string;
  stats: S;
  started_at: string;
  completed_at: string;
}

export const files = (rt: Runtime) => ({
  plan: path.join(rt.paths.work, 'discovery-plan.json'),
  manifest: path.join(rt.paths.work, 'fetch-manifest.jsonl'),
  normalized: path.join(rt.paths.work, 'normalized.jsonl'),
  normalizeIssues: path.join(rt.paths.work, 'normalize-issues.jsonl'),
  works: path.join(rt.paths.work, 'works.jsonl'),
  validated: path.join(rt.paths.work, 'validated.jsonl'),
  qualityIssues: path.join(rt.paths.work, 'quality-issues.jsonl'),
  normalizeRejected: path.join(rt.paths.quarantine, 'normalize-rejected.jsonl'),
  quarantined: path.join(rt.paths.quarantine, 'quarantined.jsonl'),
  jobsLog: path.join(rt.paths.logs, 'jobs.jsonl'),
});

export function newJobId(): string {
  return crypto.randomUUID();
}

/** Run a stage, emitting a structured job log line (data/logs/jobs.jsonl + stderr). */
export async function runStage<S extends object>(rt: Runtime, stage: string, jobId: string, fn: () => Promise<S> | S): Promise<StageResult<S>> {
  const started_at = new Date().toISOString();
  log.info(`${stage}.start`, { job_id: jobId });
  try {
    const stats = await fn();
    const result = { job_id: jobId, stage, stats, started_at, completed_at: new Date().toISOString() };
    appendJsonl(files(rt).jobsLog, { ...result, status: 'completed' });
    log.info(`${stage}.done`, { job_id: jobId, ...stats });
    return result;
  } catch (e) {
    appendJsonl(files(rt).jobsLog, { job_id: jobId, stage, status: 'failed', error: String(e), started_at, completed_at: new Date().toISOString() });
    log.error(`${stage}.failed`, { job_id: jobId, error: String(e) });
    throw e;
  }
}
