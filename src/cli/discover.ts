import { discover } from '../pipeline/discover.js';
import { newJobId, runStage } from '../pipeline/context.js';
import { main } from './common.js';

// npm run books:discover -- [--target 1000] [--queries fic-fantasy,tech-ai] [--categories Fiction] [--per-query 20]
await main(async (rt, a) =>
  runStage(rt, 'discover', newJobId(), () =>
    discover(rt, { target: a.num('target'), queries: a.list('queries'), categories: a.list('categories'), perQueryLimit: a.num('per-query') }).stats,
  ),
);
