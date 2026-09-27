import { fetchStage } from '../pipeline/fetch.js';
import { newJobId, runStage } from '../pipeline/context.js';
import { main } from './common.js';

// npm run books:fetch -- [--max-items 500] [--enrich-per-work 1]
await main(async (rt, a) => {
  const jobId = newJobId();
  return runStage(rt, 'fetch', jobId, () => fetchStage(rt, jobId, { maxItems: a.num('max-items'), enrichEditionsPerWork: a.num('enrich-per-work') }));
});
