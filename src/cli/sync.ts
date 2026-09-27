import { importIsbn, runSync } from '../pipeline/sync.js';
import { main, withRepo } from './common.js';

// npm run books:sync -- --target 100 [--queries ...] [--categories ...] [--offline]
// npm run books:sync -- --isbn 9780857197689
await main(async (rt, a) => {
  const repo = withRepo(rt);
  try {
    const isbn = a.str('isbn');
    if (isbn) return await importIsbn(rt, repo, isbn);
    const s = await runSync(rt, repo, {
      target: a.num('target'),
      queries: a.list('queries'),
      categories: a.list('categories'),
      perQueryLimit: a.num('per-query'),
      offline: a.bool('offline'),
    });
    return a.bool('verbose') ? s : { ...s, stages: undefined };
  } finally {
    repo.close();
  }
});
