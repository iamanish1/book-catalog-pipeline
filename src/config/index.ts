import fs from 'node:fs';
import path from 'node:path';
import type { SourceName } from '../domain/types.js';

export interface GenreDef {
  name: string;
  aliases: string[];
  weak?: string[];
  exclude?: string[];
  implies?: string[];
}

export interface SubcategoryDef {
  name: string;
  genres: string[];
  priority?: number;
}

export interface TaxonomyConfig {
  version: number;
  genre_rules: {
    source_weights: Record<string, number>;
    per_source_cap: number;
    accept_threshold: number;
    implied_factor: number;
    max_genres: number;
    nonfiction_genres?: string[];
  };
  genres: GenreDef[];
  categories: Array<{ name: string; subcategories: SubcategoryDef[] }>;
  fallback_categories: Record<string, string>;
}

export interface DiscoveryQueryDef {
  id: string;
  category: string | null;
  subcategory: string | null;
  genre: string | null;
  subject?: string;
  language?: string;
  limit?: number;
  open_library?: { q?: string; sort?: string };
  google_books?: { q?: string; orderBy?: string; printType?: string; langRestrict?: string };
}

export interface DiscoveryConfig {
  version: number;
  defaults: {
    open_library: { sort?: string };
    google_books: { orderBy?: string; printType?: string };
    per_query_limit: number;
  };
  queries: DiscoveryQueryDef[];
}

export interface PopularityConfig {
  version: string;
  weights: Record<'ratings_count' | 'average_rating' | 'edition_count' | 'retailer' | 'discovery', number>;
  normalization: {
    ratings_count_cap: number;
    edition_count_cap: number;
    readinglog_cap: number;
    rating_prior_mean: number;
    rating_prior_weight: number;
  };
  discovery_mix: { rank: number; readinglog: number; bestseller: number };
}

export interface SourcesConfig {
  version: number;
  sources: Array<{ name: SourceName; kind: string; base_url: string | null; terms_url: string | null; requires_key: boolean }>;
  work_precedence: Record<string, SourceName[]>;
  edition_precedence: Record<string, SourceName[]>;
}

export interface TagsConfig {
  max_tags: number;
  max_words: number;
  min_length: number;
  stop_phrases: string[];
  rewrite: Record<string, string>;
  foreign_markers?: string[];
}

export interface PublisherSiteConfig {
  name: string;
  enabled: boolean;
  terms_reviewed: boolean;
  terms_note?: string;
  url_template: string;
  min_delay_ms?: number;
  default_currency?: string;
}

export interface CatalogConfig {
  taxonomy: TaxonomyConfig;
  discovery: DiscoveryConfig;
  popularity: PopularityConfig;
  sources: SourcesConfig;
  tags: TagsConfig;
  publishers: { sites: PublisherSiteConfig[] };
}

let cached: CatalogConfig | null = null;

function readJson<T>(dir: string, file: string): T {
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as T;
}

export function configDir(): string {
  return path.resolve(process.env.BOOK_CONFIG_DIR ?? 'config');
}

export function loadConfig(dir = configDir()): CatalogConfig {
  if (cached && dir === configDir()) return cached;
  const cfg: CatalogConfig = {
    taxonomy: readJson(dir, 'taxonomy.json'),
    discovery: readJson(dir, 'discovery.json'),
    popularity: readJson(dir, 'popularity.json'),
    sources: readJson(dir, 'sources.json'),
    tags: readJson(dir, 'tags.json'),
    publishers: readJson(dir, 'publishers.json'),
  };
  validateConfig(cfg);
  if (dir === configDir()) cached = cfg;
  return cfg;
}

/** Fail fast on inconsistent taxonomy (e.g. a subcategory referencing an unknown genre). */
export function validateConfig(cfg: CatalogConfig): void {
  const genres = new Set(cfg.taxonomy.genres.map((g) => g.name));
  const errors: string[] = [];
  for (const g of cfg.taxonomy.genres) {
    for (const imp of g.implies ?? []) if (!genres.has(imp)) errors.push(`genre ${g.name} implies unknown genre ${imp}`);
  }
  const catNames = new Set<string>();
  for (const c of cfg.taxonomy.categories) {
    catNames.add(c.name);
    const subs = new Set<string>();
    for (const s of c.subcategories) {
      if (subs.has(s.name)) errors.push(`duplicate subcategory ${c.name}/${s.name}`);
      subs.add(s.name);
      for (const g of s.genres) if (!genres.has(g)) errors.push(`subcategory ${c.name}/${s.name} references unknown genre ${g}`);
    }
  }
  for (const q of cfg.discovery.queries) {
    if (q.genre && !genres.has(q.genre)) errors.push(`discovery query ${q.id} references unknown genre ${q.genre}`);
    if (q.category && !catNames.has(q.category)) errors.push(`discovery query ${q.id} references unknown category ${q.category}`);
  }
  const w = cfg.popularity.weights;
  const sum = w.ratings_count + w.average_rating + w.edition_count + w.retailer + w.discovery;
  if (Math.abs(sum - 1) > 1e-6) errors.push(`popularity weights must sum to 1 (got ${sum})`);
  if (errors.length) throw new Error(`Invalid catalog configuration:\n  ${errors.join('\n  ')}`);
}

export function resetConfigCache(): void {
  cached = null;
}
