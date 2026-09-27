import type { BookDto, MergedWork, QualityIssue } from '../domain/types.js';

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export interface ListFilters {
  category?: string;
  subcategory?: string;
  genre?: string;
  tag?: string;
  language?: string;
  author?: string;
  publisher?: string;
  yearFrom?: number;
  yearTo?: number;
  hasPrice?: boolean;
  sort?: 'popularity' | 'title' | 'year' | 'recent';
}

export interface UpsertResult {
  book_id: string;
  action: 'inserted' | 'updated';
  matched_by: string | null;
  editions_inserted: number;
  editions_updated: number;
  prices_changed: number;
  conflicts: string[];
}

export interface CatalogStats {
  books: number;
  editions: number;
  authors: number;
  books_missing_images: number;
  books_missing_prices: number;
  books_missing_isbn: number;
  books_unclassified: number;
  dedupe_candidates_pending: number;
  quality_errors: number;
  quality_warnings: number;
  source_distribution: Array<{ source: string; books: number }>;
  category_distribution: Array<{ category: string | null; books: number }>;
  last_import: JobRecord | null;
  recent_jobs: JobRecord[];
}

export interface JobRecord {
  job_id: string;
  kind: string;
  status: 'running' | 'completed' | 'failed';
  params: Record<string, unknown>;
  stats: Record<string, unknown>;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface EditionDto {
  id: string;
  title: string;
  subtitle: string | null;
  isbn_10: string | null;
  isbn_13: string | null;
  publisher: string | null;
  publication_year: number | null;
  language: string | null;
  page_count: number | null;
  format: string | null;
  edition_name: string | null;
  identifiers: { google_books_id: string | null; open_library_edition_id: string | null; asin: string | null };
  price: BookDto['price'];
  price_metadata: BookDto['price_metadata'];
  offers: Array<{ amount: number; currency: string; source: string; offer_format: string | null; buy_url: string | null; retrieved_at: string }>;
  images: BookDto['images'];
  image_metadata: BookDto['image_metadata'];
  sources: string[];
  source_urls: string[];
  field_sources: Record<string, string>;
  is_primary: boolean;
}

/** Storage-agnostic catalog repository (SQLite implementation provided; Postgres can implement the same contract). */
export interface CatalogRepository {
  migrate(): void;
  syncReferenceData(input: {
    categories: Array<{ name: string; subcategories: Array<{ name: string }> }>;
    genres: string[];
    sources: Array<{ name: string; kind: string; base_url: string | null; terms_url: string | null; requires_key: boolean; enabled: boolean; disabled_reason: string | null }>;
  }): void;
  upsertWork(work: MergedWork, jobId: string | null): UpsertResult;
  transaction<T>(fn: () => T): T;
  recordQualityIssues(jobId: string | null, stage: string, recordKey: string, title: string | null, issues: QualityIssue[]): void;

  listBooks(filters: ListFilters, page: number, limit: number): Page<BookDto>;
  getBook(id: string): BookDto | null;
  getBookByIsbn(isbn13: string): BookDto | null;
  search(q: string, page: number, limit: number, filters?: ListFilters): Page<BookDto & { relevance: number }>;
  listEditions(bookId: string, page: number, limit: number): Page<EditionDto> | null;
  categoriesWithCounts(): Array<{ name: string; slug: string; books: number; subcategories: Array<{ name: string; slug: string; books: number }> }>;
  genresWithCounts(): Array<{ name: string; slug: string; books: number }>;

  startJob(jobId: string, kind: string, params: Record<string, unknown>): void;
  finishJob(jobId: string, status: 'completed' | 'failed', stats: Record<string, unknown>, error?: string | null): void;
  getJob(jobId: string): JobRecord | null;
  stats(): CatalogStats;
  qualityErrors(page: number, limit: number, severity?: 'error' | 'warning'): Page<Record<string, unknown>>;
  close(): void;
}
