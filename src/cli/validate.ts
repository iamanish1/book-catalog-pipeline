import { validateStage } from '../pipeline/validate.js';
import { newJobId, runStage } from '../pipeline/context.js';
import { main } from './common.js';

await main(async (rt) => runStage(rt, 'validate', newJobId(), () => validateStage(rt)));
