import { dedupeStage } from '../pipeline/dedupe.js';
import { newJobId, runStage } from '../pipeline/context.js';
import { main } from './common.js';

await main(async (rt) => runStage(rt, 'dedupe', newJobId(), () => dedupeStage(rt)));
