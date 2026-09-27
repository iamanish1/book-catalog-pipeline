import type { AppEnv } from '../config/env.js';
import type { CatalogConfig } from '../config/index.js';
import type { BookDataProvider } from '../providers/types.js';
import type { CatalogRepository } from './repository.js';
import { openSqlite, SqliteCatalogRepository } from './sqlite.js';

/** Open the catalog repository for DATABASE_URL, apply migrations and sync taxonomy/source tables. */
export function openRepository(env: AppEnv, config: CatalogConfig, providers: BookDataProvider[] = []): CatalogRepository {
  const url = env.databaseUrl;
  if (/^postgres(ql)?:\/\//.test(url)) {
    throw new Error('PostgreSQL is not wired up yet: implement CatalogRepository (src/db/repository.ts) for Postgres. See README "Database".');
  }
  if (!/^(file:|sqlite:)/.test(url) && url !== ':memory:') throw new Error(`Unsupported DATABASE_URL: ${url}`);
  const repo = new SqliteCatalogRepository(openSqlite(url), { sources: config.sources, priceStaleMs: env.priceCacheMs });
  repo.migrate();
  const enabled = new Map(providers.map((p) => [p.name, p]));
  repo.syncReferenceData({
    categories: config.taxonomy.categories,
    genres: config.taxonomy.genres.map((g) => g.name),
    sources: config.sources.sources.map((s) => {
      const p = enabled.get(s.name);
      return { ...s, enabled: p ? p.isEnabled() : false, disabled_reason: p ? p.disabledReason() : 'provider not registered' };
    }),
  });
  return repo;
}
