import { importStage } from '../pipeline/import.js';
import { newJobId, runStage } from '../pipeline/context.js';
import { main, withRepo } from './common.js';

// npm run books:import -- [--limit 1000]
await main(async (rt, a) => {
  const repo = withRepo(rt);
  const jobId = newJobId();
  repo.startJob(jobId, 'import', { limit: a.num('limit') ?? null });
  try {
    const res = await runStage(rt, 'import', jobId, () => importStage(rt, repo, jobId, { limit: a.num('limit') }));
    repo.finishJob(jobId, 'completed', res.stats as unknown as Record<string, unknown>);
    return res;
  } catch (e) {
    repo.finishJob(jobId, 'failed', {}, String(e));
    throw e;
  } finally {
    repo.close();
  }
});
