/**
 * Domain model.
 *
 * A *work* is the underlying book ("Harry Potter and the Philosopher's Stone").
 * An *edition* is one commercial publication of it (UK paperback, US hardcover…).
 * Prices, ISBNs, publisher, format and covers are edition-level facts.
 */

export type SourceName = 'google_books' | 'open_library' | 'amazon' | 'publisher' | (string & {});

export type EditionFormat =
  | 'Paperback'
  | 'Hardcover'
  | 'Mass Market Paperback'
  | 'eBook'
  | 'Audiobook'
  | 'Board Book'
  | 'Library Binding'
  | 'Spiral-bound'
  | 'Other';

export interface ImageRef {
  kind: 'front' | 'back';
  url: string;
  source: SourceName;
  /** License/usage terms if the source states them; null when unknown. */
  license: string | null;
  retrieved_at: string;
  /** Set by image validation: true reachable, false unreachable, null not checked. */
  reachable?: boolean | null;
  content_type?: string | null;
}

export interface PriceOffer {
  amount: number;
  currency: string;
  source: SourceName;
  /** Which product the price is for (e.g. Google Books prices are usually for the eBook). */
  offer_format: EditionFormat | null;
  buy_url: string | null;
  retrieved_at: string;
  /** Original price text/structure as returned by the source, for audit. */
  raw: string | null;
}

/** Raw popularity signals, preserved exactly as the source reported them. */
export interface PopularitySignals {
  average_rating: number | null;
  ratings_count: number | null;
  edition_count: number | null;
  /** Open Library reading-log counts (want to read / reading / read). */
  readinglog_count: number | null;
  /** Count of bestseller-list markers present in source subjects (e.g. Open Library "nyt:*"). */
  bestseller_mentions: number | null;
  retailer_available: boolean | null;
}

export interface DiscoveryHit {
  query_id: string;
  source: SourceName;
  rank: number;
  total: number;
  category_hint: string | null;
  subcategory_hint: string | null;
  genre_hint: string | null;
}

interface SourceRecordBase {
  source: SourceName;
  /** Stable id within the source (volume id, OL edition key, ASIN, URL…). */
  source_id: string;
  source_url: string | null;
  raw_ref: string | null;
  retrieved_at: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  description: string | null;
  categories_raw: string[];
  subjects_raw: string[];
  images: ImageRef[];
  signals: PopularitySignals;
  discovery: DiscoveryHit[];
  identifiers: {
    google_books_id: string | null;
    open_library_work_id: string | null;
    open_library_edition_id: string | null;
    asin: string | null;
  };
  /** Validation notes produced during normalization (e.g. invalid ISBNs dropped). */
  warnings: string[];
}

/** Work-level facts from a source that models works (Open Library). */
export interface WorkSourceRecord extends SourceRecordBase {
  record_type: 'work';
  first_publication_year: number | null;
  /** ISBN-13s the source associates with this work (used for linking, never as edition identity). */
  known_isbn13s: string[];
  language: null;
}

/** Edition-level facts. Google Books volumes and retailer items are editions. */
export interface EditionSourceRecord extends SourceRecordBase {
  record_type: 'edition';
  isbn_10: string | null;
  isbn_13: string | null;
  publisher: string | null;
  publication_year: number | null;
  /** First publication year of the underlying work, if the source reports it. */
  first_publication_year: number | null;
  language: string | null;
  page_count: number | null;
  format: EditionFormat | null;
  edition_name: string | null;
  price: PriceOffer | null;
}

export type SourceRecord = WorkSourceRecord | EditionSourceRecord;

export interface FieldConflict {
  field: string;
  chosen: { source: SourceName; value: unknown };
  alternatives: Array<{ source: SourceName; value: unknown }>;
}

export interface GenreEvidence {
  raw: string;
  normalized: string;
  source: SourceName;
}

export interface MergedEdition {
  key: string;
  title: string;
  subtitle: string | null;
  isbn_10: string | null;
  isbn_13: string | null;
  publisher: string | null;
  publication_year: number | null;
  language: string | null;
  page_count: number | null;
  format: EditionFormat | null;
  edition_name: string | null;
  identifiers: { google_books_id: string | null; open_library_edition_id: string | null; asin: string | null };
  images: ImageRef[];
  offers: PriceOffer[];
  sources: SourceName[];
  source_urls: string[];
  field_sources: Record<string, SourceName>;
  conflicts: FieldConflict[];
  record_refs: string[];
}

export interface PopularityResult {
  score: number | null;
  rating: number | null;
  ratings_count: number | null;
  popularity_source: 'internal_normalized_score';
  components: Record<string, number>;
  weights: Record<string, number>;
  raw_signals: Record<string, PopularitySignals>;
  formula_version: string;
}

export interface MergedWork {
  key: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  first_publication_year: number | null;
  description: string | null;
  short_description: string | null;
  genres: string[];
  genre_evidence: GenreEvidence[];
  category: string | null;
  subcategory: string | null;
  tags: string[];
  popularity: PopularityResult;
  identifiers: { open_library_work_id: string | null };
  primary_source: SourceName;
  sources: SourceName[];
  source_urls: string[];
  field_sources: Record<string, SourceName>;
  conflicts: FieldConflict[];
  editions: MergedEdition[];
  discovery: DiscoveryHit[];
  /** Fuzzy near-duplicates that were NOT merged (need stronger evidence / human review). */
  duplicate_candidates: Array<{ other_key: string; other_title: string; similarity: number; reason: string }>;
  duplicate_probability: number;
}

export interface QualityIssue {
  field: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

/** Public API shape (matches the product schema; work + its primary edition). */
export interface BookDto {
  id: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  publication_year: number | null;
  genre: string[];
  popularity: { score: number | null; rating: number | null; ratings_count: number | null; popularity_source: string };
  price: { amount: number; currency: string } | null;
  price_metadata: { source: string; retrieved_at: string; offer_format: string | null; buy_url: string | null; is_stale: boolean } | null;
  short_description: string | null;
  images: { front: string | null; back: string | null };
  image_metadata: { front: Omit<ImageRef, 'kind'> | null; back: Omit<ImageRef, 'kind'> | null };
  tags: string[];
  category: string | null;
  subcategory: string | null;
  isbn_10: string | null;
  isbn_13: string | null;
  publisher: string | null;
  language: string | null;
  page_count: number | null;
  edition: { id: string; edition_name: string | null; edition_year: number | null; format: string | null; publisher: string | null } | null;
  editions_count: number;
  identifiers: { google_books_id: string | null; open_library_work_id: string | null; open_library_edition_id: string | null };
  source: { primary: string; sources: string[] };
  source_urls: string[];
  field_sources: Record<string, string>;
  metadata: { created_at: string; updated_at: string };
}
