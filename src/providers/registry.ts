import path from 'node:path';
import type { AppEnv } from '../config/env.js';
import { getEnv } from '../config/env.js';
import type { CatalogConfig } from '../config/index.js';
import { loadConfig } from '../config/index.js';
import { HttpClient } from '../lib/http.js';
import { RawStore } from '../lib/raw-store.js';
import { AmazonProvider } from './amazon.js';
import { GoogleBooksProvider } from './google-books.js';
import { OpenLibraryProvider } from './open-library.js';
import { PublisherProvider } from './publisher.js';
import type { BookDataProvider } from './types.js';

export interface Runtime {
  env: AppEnv;
  config: CatalogConfig;
  rawStore: RawStore;
  http: HttpClient;
  providers: BookDataProvider[];
  paths: { data: string; raw: string; work: string; quarantine: string; logs: string };
}

export function userAgent(env: AppEnv): string {
  const contact = env.openLibraryContactEmail ? ` (${env.openLibraryContactEmail})` : '';
  return `BookCatalogPipeline/0.1${contact}`;
}

export function createRuntime(overrides: Partial<{ env: AppEnv; fetchImpl: typeof fetch; config: CatalogConfig }> = {}): Runtime {
  const env = overrides.env ?? getEnv();
  const config = overrides.config ?? loadConfig();
  const paths = {
    data: env.dataDir,
    raw: path.join(env.dataDir, 'raw'),
    work: path.join(env.dataDir, 'work'),
    quarantine: path.join(env.dataDir, 'quarantine'),
    logs: path.join(env.dataDir, 'logs'),
  };
  const rawStore = new RawStore(paths.raw, { metadata: env.metadataCacheMs, price: env.priceCacheMs, image: env.imageCacheMs });
  const perHost: Record<string, number> = {
    // Open Library allows ~3 req/s for identified clients; stay under it.
    'openlibrary.org': Math.max(env.requestDelayMs, 400),
    'covers.openlibrary.org': Math.max(env.requestDelayMs, 400),
    // PA-API default is 1 request/second.
    [env.amazon.host]: Math.max(env.requestDelayMs, 1100),
  };
  const ua = userAgent(env);
  const http = new HttpClient({
    rawStore,
    userAgent: ua,
    defaultDelayMs: env.requestDelayMs,
    perHostDelayMs: perHost,
    timeoutMs: env.requestTimeoutMs,
    maxRetries: env.maxRetries,
    fetchImpl: overrides.fetchImpl,
  });
  const providers: BookDataProvider[] = [
    new OpenLibraryProvider(http, env),
    new GoogleBooksProvider(http, env),
    new AmazonProvider(http, env),
    new PublisherProvider(http, config.publishers.sites, ua),
  ];
  return { env, config, rawStore, http, providers, paths };
}

export function providerByName(rt: Runtime, name: string): BookDataProvider | undefined {
  return rt.providers.find((p) => p.name === name);
}
