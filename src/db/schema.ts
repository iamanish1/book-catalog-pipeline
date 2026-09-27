/**
 * Relational schema (SQLite dialect; types/constraints chosen to port directly to
 * PostgreSQL: TEXT→text, REAL→numeric, JSON TEXT→jsonb, FTS5→tsvector/GIN).
 *
 * books            = works (one row per underlying book)
 * book_editions    = commercial publications of a work (ISBN, publisher, format…)
 * edition_prices   = price offers per edition, with history (is_current)
 * edition_images   = cover images per edition, with provenance/licence
 */
export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE data_sources (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  base_url TEXT,
  terms_url TEXT,
  requires_key INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ux_categories_parent_slug ON categories(COALESCE(parent_id, 0), slug);

CREATE TABLE genres (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE authors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  author_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_authors_name ON authors(name COLLATE NOCASE);

CREATE TABLE books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT,
  title_key TEXT NOT NULL,
  author_key TEXT NOT NULL,
  first_publication_year INTEGER,
  description TEXT,
  short_description TEXT,
  category_id INTEGER REFERENCES categories(id),
  subcategory_id INTEGER REFERENCES categories(id),
  popularity_score REAL,
  rating REAL,
  ratings_count INTEGER,
  popularity_source TEXT,
  popularity_detail TEXT,
  open_library_work_id TEXT UNIQUE,
  primary_edition_id TEXT,
  primary_source TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',
  source_urls TEXT NOT NULL DEFAULT '[]',
  field_sources TEXT NOT NULL DEFAULT '{}',
  conflicts TEXT NOT NULL DEFAULT '[]',
  genre_evidence TEXT NOT NULL DEFAULT '[]',
  duplicate_probability REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_books_title_key ON books(title_key);
CREATE INDEX ix_books_title_author ON books(title_key, author_key);
CREATE INDEX ix_books_title ON books(title COLLATE NOCASE);
CREATE INDEX ix_books_category ON books(category_id, popularity_score DESC);
CREATE INDEX ix_books_subcategory ON books(subcategory_id, popularity_score DESC);
CREATE INDEX ix_books_year ON books(first_publication_year);
CREATE INDEX ix_books_popularity ON books(popularity_score DESC);

CREATE TABLE book_authors (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES authors(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (book_id, author_id)
);
CREATE INDEX ix_book_authors_author ON book_authors(author_id);

CREATE TABLE book_genres (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES genres(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (book_id, genre_id)
);
CREATE INDEX ix_book_genres_genre ON book_genres(genre_id);

CREATE TABLE book_tags (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (book_id, tag_id)
);
CREATE INDEX ix_book_tags_tag ON book_tags(tag_id);

CREATE TABLE book_editions (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  subtitle TEXT,
  isbn_10 TEXT UNIQUE CHECK (isbn_10 IS NULL OR length(isbn_10) = 10),
  isbn_13 TEXT UNIQUE CHECK (isbn_13 IS NULL OR length(isbn_13) = 13),
  publisher TEXT,
  publication_year INTEGER,
  language TEXT,
  page_count INTEGER CHECK (page_count IS NULL OR page_count > 0),
  format TEXT,
  edition_name TEXT,
  google_books_id TEXT UNIQUE,
  open_library_edition_id TEXT UNIQUE,
  asin TEXT UNIQUE,
  sources TEXT NOT NULL DEFAULT '[]',
  source_urls TEXT NOT NULL DEFAULT '[]',
  field_sources TEXT NOT NULL DEFAULT '{}',
  conflicts TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_editions_book ON book_editions(book_id);
CREATE INDEX ix_editions_publisher ON book_editions(publisher COLLATE NOCASE);

CREATE TABLE edition_prices (
  id INTEGER PRIMARY KEY,
  edition_id TEXT NOT NULL REFERENCES book_editions(id) ON DELETE CASCADE,
  amount REAL NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  source TEXT NOT NULL,
  offer_format TEXT,
  buy_url TEXT,
  raw TEXT,
  retrieved_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_prices_edition ON edition_prices(edition_id, is_current);

CREATE TABLE edition_images (
  id INTEGER PRIMARY KEY,
  edition_id TEXT NOT NULL REFERENCES book_editions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('front', 'back')),
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  license TEXT,
  reachable INTEGER,
  content_type TEXT,
  retrieved_at TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (edition_id, url)
);

CREATE TABLE source_records (
  id INTEGER PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  edition_id TEXT REFERENCES book_editions(id) ON DELETE SET NULL,
  record_ref TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  retrieved_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_source_records_book ON source_records(book_id);
CREATE INDEX ix_source_records_source ON source_records(source);

CREATE TABLE dedupe_candidates (
  id INTEGER PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  other_key TEXT NOT NULL,
  other_title TEXT,
  similarity REAL NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  UNIQUE (book_id, other_key)
);

CREATE TABLE data_quality_errors (
  id INTEGER PRIMARY KEY,
  job_id TEXT,
  stage TEXT NOT NULL,
  record_key TEXT,
  title TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('error', 'warning')),
  code TEXT NOT NULL,
  field TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_dq_job ON data_quality_errors(job_id, severity);
CREATE INDEX ix_dq_code ON data_quality_errors(code);

CREATE TABLE import_jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  stats TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX ix_import_jobs_started ON import_jobs(started_at DESC);

CREATE VIRTUAL TABLE books_fts USING fts5(
  book_id UNINDEXED,
  title,
  authors,
  isbns,
  publisher,
  category,
  genres,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);
`,
  },
];
