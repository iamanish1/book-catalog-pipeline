import type { DiscoveryQueryDef } from '../config/index.js';
import type { EditionSourceRecord, SourceName, SourceRecord, WorkSourceRecord } from '../domain/types.js';
import type { RawStore } from '../lib/raw-store.js';

/** A provider's view of one book: optional work-level facts plus editions. */
export interface ProviderBook {
  work: WorkSourceRecord | null;
  editions: EditionSourceRecord[];
}

/**
 * A fetched unit of raw data, recorded in the fetch manifest. Normalization
 * re-reads the referenced raw files, so it runs offline and is repeatable.
 */
export interface FetchedItem {
  source: SourceName;
  /** Provider-specific item key (OL work id, GB volume id, ASIN, page URL). */
  item_key: string;
  role: 'discovery' | 'enrichment';
  query_id: string | null;
  rank: number | null;
  total: number | null;
  raw_refs: string[];
  /** Extra provider-specific pointers (e.g. index of the item within a search page). */
  locator: Record<string, string | number>;
  /** Discovery-query hints (bias classification; never assign it alone). */
  hints: { category: string | null; subcategory: string | null; genre: string | null; language: string | null } | null;
  fetched_at: string;
}

export interface NormalizeResult {
  records: SourceRecord[];
  rejected: Array<{ record: SourceRecord; reason: string }>;
}

export interface ResolvedDiscoveryQuery extends DiscoveryQueryDef {
  limit: number;
}

export interface EnrichmentTarget {
  isbn_13: string;
  isbn_10: string | null;
}

/**
 * Independently replaceable data provider. Online methods fetch through the
 * shared HTTP client (throttled, cached, raw-stored); `normalizeItem` is pure
 * with respect to the network.
 */
export interface BookDataProvider {
  readonly name: SourceName;
  /** False when required credentials/config are missing (provider is skipped, not faked). */
  isEnabled(): boolean;
  disabledReason(): string | null;

  searchBooks(query: string, limit?: number): Promise<ProviderBook[]>;
  getBookByISBN(isbn: string): Promise<ProviderBook | null>;
  getBookById(id: string): Promise<ProviderBook | null>;

  /** Discovery stage: find candidate items for a query. */
  discover?(query: ResolvedDiscoveryQuery): Promise<FetchedItem[]>;
  /** Enrichment: fetch this provider's data for a known edition ISBN. */
  enrichByIsbn?(target: EnrichmentTarget, queryId: string | null): Promise<FetchedItem[]>;

  normalizeItem(item: FetchedItem, store: RawStore): NormalizeResult;
}

export function toProviderBooks(records: SourceRecord[]): ProviderBook[] {
  const works = records.filter((r): r is WorkSourceRecord => r.record_type === 'work');
  const editions = records.filter((r): r is EditionSourceRecord => r.record_type === 'edition');
  if (works.length === 0) return editions.map((e) => ({ work: null, editions: [e] }));
  return works.map((w) => ({
    work: w,
    editions: editions.filter((e) => e.identifiers.open_library_work_id === w.identifiers.open_library_work_id),
  }));
}
