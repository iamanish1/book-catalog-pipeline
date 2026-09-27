import { normalizeStage } from '../pipeline/normalize.js';
import { newJobId, runStage } from '../pipeline/context.js';
import { main } from './common.js';

await main(async (rt) => runStage(rt, 'normalize', newJobId(), () => normalizeStage(rt)));
