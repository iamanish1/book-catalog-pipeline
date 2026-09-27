import { openRepository } from '../db/index.js';
import { log } from '../lib/logger.js';
import { createRuntime } from '../providers/registry.js';
import { createApp } from './app.js';

const rt = createRuntime();
const repo = openRepository(rt.env, rt.config, rt.providers);
const app = createApp({ rt, repo });

if (!rt.env.adminApiToken) {
  log.warn(rt.env.nodeEnv === 'production' ? 'ADMIN_API_TOKEN not set: internal endpoints are disabled' : 'ADMIN_API_TOKEN not set: internal endpoints are open (development only)');
}

const server = app.listen(rt.env.port, () => {
  log.info('api listening', { port: rt.env.port, admin_dashboard: `http://localhost:${rt.env.port}/admin/` });
});

const shutdown = () => {
  server.close(() => {
    repo.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
