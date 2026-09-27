# Book Catalog Pipeline

A source-aware ingestion, normalization and deduplication pipeline that builds a commerce-ready book catalog from
official APIs (Open Library, Google Books, Amazon PA-API) and explicitly permitted publisher pages, plus a REST API and
an admin import dashboard.

Principles: **prefer official APIs, never fabricate data, keep provenance for every field, distinguish works from
editions, deduplicate aggressively but safely, and make every run reproducible from stored raw responses.**

---

## Quick start

```bash
npm install
cp .env.example .env            # optional: add GOOGLE_BOOKS_API_KEY, contact email, etc.
npm run books:sync -- --target 100   # discover → fetch → normalize → dedupe → validate → import
npm run books:verify                 # checks dedupe, ISBNs, editions, categories, images, prices, popularity, search, API
npm run dev                          # API on http://localhost:3000, dashboard at /admin/
```

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`; developed on Node 24).

## Keys and configuration

| Variable | Required? | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | defaults to `file:./data/catalog.db` | SQLite catalog database |
| `GOOGLE_BOOKS_API_KEY` | **optional, strongly recommended** | Descriptions, categories, ratings, Google Play prices. The anonymous quota is often 0/day, so without a key the provider is **skipped** (not faked). |
| `GOOGLE_BOOKS_COUNTRY` | default `IN` | Country for `saleInfo` (prices come back in that country's currency, e.g. INR) |
| `OPEN_LIBRARY_CONTACT_EMAIL` | optional (recommended by Open Library) | Sent in the `User-Agent` so Open Library can contact you |
| `AMAZON_ACCESS_KEY`, `AMAZON_SECRET_KEY`, `AMAZON_PARTNER_TAG` | optional | Enables the PA-API provider (retail prices, bindings). Needs an approved Associates account. Check Amazon's current API docs before enabling. |
| `ADMIN_API_TOKEN` | **required in production** | Bearer token for `POST /api/catalog/*` and `/api/admin/*` (open only when `NODE_ENV≠production` and unset) |
| `BOOK_IMPORT_BATCH_SIZE` | default 100 | Works per DB transaction |
| `BOOK_REQUEST_DELAY_MS` | default 500 | Minimum delay between requests to one host (Open Library ≥ 400 ms, PA-API ≥ 1100 ms enforced) |
| `BOOK_METADATA_CACHE_DAYS` / `BOOK_PRICE_CACHE_HOURS` / `BOOK_IMAGE_CACHE_DAYS` | 30 / 12 / 30 | Cache TTLs per class |
| `BOOK_IMAGE_VALIDATION` | `primary` | `primary` \| `all` \| `none`: HEAD-check cover URLs before import |
| `BOOK_DUPLICATE_QUARANTINE_THRESHOLD` | 0.9 | Fuzzy duplicate probability at which the weaker record is quarantined |

Open Library is the only source that works with **no keys at all**, so the pipeline runs out of the box.

## Architecture

```
config/                 taxonomy, genre rules, discovery queries, popularity weights, source precedence, tag rules, publisher allow-list
src/
  providers/            BookDataProvider implementations: open-library, google-books, amazon (PA-API 5), publisher (JSON-LD)
  scrapers/             robots.txt policy + ScraperAdapter (terms-review gate, throttling) + schema.org extractor
  lib/                  http (throttle, retry+jitter, Retry-After, circuit breaker), raw-store (raw responses = cache), isbn, text, currency
  normalize/            genre normalizer, taxonomy classifier, tags, formats, images, field merge with precedence, work builder
  matching/dedupe.ts    edition identity clustering + work grouping + fuzzy candidate generation
  scoring/popularity.ts internal popularity score
  validation/           data-quality rules, probable-duplicate quarantine
  pipeline/             stages: discover, fetch, normalize, dedupe, validate, import, sync (+ single-ISBN import)
  db/                   schema (migrations), CatalogRepository interface, SQLite implementation
  api/                  Express app (REST + admin)
public/admin/           import dashboard (static)
data/                   raw/, work/, quarantine/, logs/, catalog.db  (git-ignored, reproducible)
```

### Work vs edition

```
books (work) ── book_authors / book_genres / book_tags / category + subcategory / popularity
   └── book_editions (ISBN-10/13, publisher, format, language, pages, edition year, OL edition id, GB id, ASIN)
          ├── edition_prices  (amount, ISO-4217 currency, source, offer_format, buy_url, retrieved_at, is_current → history)
          └── edition_images  (front/back, url, source, licence, reachable, retrieved_at)
source_records      provenance: which source record fed which book/edition
dedupe_candidates   fuzzy near-duplicates awaiting review (never auto-merged)
data_quality_errors every error/warning per job
import_jobs         structured job history
data_sources, categories (tree), genres, tags, authors
books_fts           FTS5 search index
```

Price, ISBN, publisher, format and covers are **edition-level**. The API shows a work together with its
*primary edition*, which is the most commercially complete one (has a price, a cover, an ISBN-13, a publisher, a print format).
`GET /api/books/:id/editions` lists all editions.

The schema is written for SQLite with portable types and constraints. PostgreSQL support means implementing
`CatalogRepository` (`src/db/repository.ts`); FTS5 maps to `tsvector` + GIN. `DATABASE_URL=postgres://…` currently
fails fast with that message.

## Pipeline

```
DISCOVERY → FETCH → RAW STORAGE → NORMALIZATION → IDENTIFIER EXTRACTION → DEDUPLICATION → EDITION MATCHING
  → CATEGORY NORMALIZATION → IMAGE VALIDATION → PRICE NORMALIZATION → QUALITY VALIDATION → DATABASE UPSERT
```

| Command | Stage(s) | Output |
| --- | --- | --- |
| `npm run books:discover -- --target 1000` | query plan from `config/discovery.json` | `data/work/discovery-plan.json` |
| `npm run books:fetch` | discovery queries + ISBN enrichment across providers | `data/raw/<source>/…`, `data/work/fetch-manifest.jsonl` |
| `npm run books:normalize` | normalize, extract identifiers, parse prices (offline) | `normalized.jsonl`, `quarantine/normalize-rejected.jsonl` |
| `npm run books:dedupe` | dedupe, edition matching, merge, genres/categories/tags, popularity | `works.jsonl` |
| `npm run books:validate` | image HEAD checks, quality rules, duplicate quarantine | `validated.jsonl`, `quarantine/quarantined.jsonl` |
| `npm run books:import -- [--limit N]` | batched upsert with DB-level dedupe | SQLite |
| `npm run books:sync -- --target N` | all of the above | job summary |
| `npm run books:sync -- --offline` | re-process stored raw data only, with no network | |
| `npm run books:sync -- --isbn 9780857197689` | on-demand single ISBN from all providers | |
| `npm run books:verify` | post-import verification report | exit code ≠ 0 on hard failures |

Options for discover/sync: `--queries fic-fantasy,tech-ai`, `--categories Fiction,Technology`, `--per-query 20`.

**Reprocessing:** every external response is stored in `data/raw/` with its URL (API keys redacted), status and
timestamp, and the same files are the HTTP cache. Changing the taxonomy, genre rules, tag rules, popularity weights
or source precedence only needs `npm run books:dedupe && npm run books:validate && npm run books:import`
(or `books:sync -- --offline`). None of these hit the network.

**Logging:** each stage and each discovery query appends a structured line to `data/logs/jobs.jsonl` and to stderr
(`job_id`, `source`, `query`, `fetched`, `normalized`, `duplicates`, `inserted`, `failed`, `started_at`, `completed_at`).
Sync summaries are also stored in `import_jobs`.

### Scaling 1K → 10K → 50K+

Discovery spreads the target across all configured queries, with a 1.3× over-fetch to absorb cross-query duplicates.
Import can cap to the top-N by popularity (`--limit`). Suggested progression:

```bash
npm run books:sync -- --target 100     # Phase 0: verify (npm run books:verify)
npm run books:sync -- --target 1000    # Phase 1
npm run books:sync -- --target 10000   # Phase 2 (hours at polite rates; resumable thanks to the cache)
```

Open Library allows ~3 req/s for identified clients. Each discovered work costs 2 requests (work + editions) plus
enrichment, so 10K works take roughly 2–3 hours at the default throttle. Re-runs are served from cache. For 50K+,
add more discovery queries (for example more subjects per category, or `sort=editions`), keep Open Library runs
spread out, and use Google Books with a key for description/price enrichment. Don't bulk-download from Open Library's
live API. Their monthly data dumps are the right tool for millions of records.

## Sources and compliance

* **Open Library**: work/edition identity, ISBNs, first publication year, subjects, covers, ratings/reading-log
  signals. Throttled to at most 2.5 req/s, identified User-Agent, cached for 30 days.
* **Google Books**: descriptions, BISAC-style categories, ratings, `saleInfo` prices. Google Play prices are almost
  always **eBook** offers and are stored with `offer_format: "eBook"`, so they are never presented as a paperback price.
* **Amazon PA-API 5**: official API only (SigV4-signed). Retail price and binding per edition. Cache class `price` (12 h).
* **PublisherProvider**: reads schema.org JSON-LD from sites listed in `config/publishers.json` **only if**
  `enabled` and `terms_reviewed` are both true. robots.txt is enforced (a 401/403 on robots.txt means "do not crawl"),
  Crawl-delay is honored, and a JSON-LD product is accepted only if its ISBN matches the requested one.

The code never solves CAPTCHAs, uses stealth browsers, rotates proxies, logs in, or works around rate limits. On `429`
it waits (Retry-After), and on an exhausted daily quota it stops calling that host.

## Deduplication rules

1. **Edition identity** (strongest first): ISBN-13 → ISBN-10 → Open Library edition id → Google Books id → ASIN.
   Records sharing a key are the same edition, **unless they carry different ISBN-13s** (never merged; logged as an
   identity conflict).
2. **Work grouping**: an edition joins a work through (a) its Open Library work id, (b) an ISBN the work lists, or
   (c) an **exact** normalized title (subtitle, case, punctuation, diacritics and leading article removed) plus
   compatible author keys (surname + first initial, so "J.K. Rowling" = "Rowling, J. K.").
3. Open Library works that share an edition ISBN and have similar titles are merged (OL has duplicate work records).
4. **Fuzzy matching only generates candidates**, stored in `dedupe_candidates`. At or above the threshold, the weaker
   record is quarantined for review rather than merged.
5. At import the database is checked in the same priority order (ISBN-13 → ISBN-10 → OL edition → GB id → OL work →
   title + author, with year sanity). An edition that already belongs to another book is never moved.

Field conflicts are never silently overwritten. Every book and edition stores `field_sources` (which source supplied each
field) and `conflicts` (alternative values). Precedence lives in `config/sources.json`.

Open Library editions whose titles show a different product (summaries, "concise" knock-offs, mis-linked titles in the
same language) are excluded and written to `data/quarantine/normalize-rejected.jsonl`.

## Classification, tags, popularity

* **Genres**: raw categories and subjects are matched against the controlled genre list in `config/taxonomy.json`
  using weighted evidence (Google Books/Amazon 1.0, Open Library 0.6 per term, discovery hint 0.5, acceptance ≥ 1.0).
  A single community subject or a discovery hint alone cannot assign a genre. On novels, non-fiction subjects
  ("Artificial intelligence" on *Ender's Game*) are kept as tags rather than genres.
* **Category/subcategory**: chosen from the configured tree. There is no invented fallback: an unclassifiable work gets
  `null` and a quality warning.
* **Tags**: lowercase, deduplicated, at most 4 words, built from genres, subcategory and subject headings. Catalogue noise
  ("Accessible book", "nyt:…"), inverted headings and common non-English headings are filtered out.
* **Popularity** (`config/popularity.json`): `0.40·ratings_count + 0.20·avg_rating(Bayesian-shrunk) +
  0.15·edition_count + 0.15·retailer + 0.10·discovery(rank, reading-log, bestseller markers)`, 0–100.
  `popularity_source` is always `internal_normalized_score`. **This is not an industry ranking.** Raw signals per
  source are stored in `books.popularity_detail`. With no signals at all the score is `null`.

## REST API

All list endpoints are paginated (`page`, `limit` ≤ 100) and return `{ items, page, limit, total, total_pages }`.

```
GET  /api/books                   ?category&subcategory&genre&tag&author&publisher&language&year_from&year_to&has_price&sort=popularity|title|year|recent
GET  /api/books/search?q=         title / author / ISBN / publisher / category / genre / tags; ranks ISBN > exact title > author > relevance > popularity
GET  /api/books/popular
GET  /api/books/isbn/:isbn        ISBN-10 or ISBN-13; returns that edition as the book's edition
GET  /api/books/category/:slug    category or subcategory (name or slug, e.g. business-and-economics, fantasy)
GET  /api/books/genre/:genre
GET  /api/books/:id
GET  /api/books/:id/editions
GET  /api/categories  |  GET /api/genres  |  GET /health

POST /api/catalog/import          {"target":1000,"categories":["Fiction"]} → 202 {job_id}     (admin)
POST /api/catalog/import/isbn     {"isbn":"9780857197689"}                                    (admin)
GET  /api/catalog/jobs/:id                                                                    (admin)
GET  /api/admin/stats | GET /api/admin/quality-errors?severity=error                         (admin)
GET  /admin/                      import dashboard
```

Book response (product schema plus provenance):

```json
{
  "id": "…", "title": "The Psychology of Money", "authors": ["Morgan Housel"], "publication_year": 2020,
  "genre": ["Finance", "Self Help"], "category": "Business & Economics", "subcategory": "Finance",
  "popularity": { "score": 61.2, "rating": 3.99, "ratings_count": 422, "popularity_source": "internal_normalized_score" },
  "price": { "amount": 299, "currency": "INR" },
  "price_metadata": { "source": "google_books", "retrieved_at": "…", "offer_format": "eBook", "buy_url": "…", "is_stale": false },
  "images": { "front": "https://covers.openlibrary.org/b/id/…-L.jpg?default=false", "back": null },
  "image_metadata": { "front": { "url": "…", "source": "open_library", "license": null, "retrieved_at": "…" }, "back": null },
  "isbn_10": "0857197681", "isbn_13": "9780857197689", "publisher": "Harriman House", "language": "en", "page_count": 256,
  "edition": { "id": "…", "edition_name": null, "edition_year": 2020, "format": "Paperback", "publisher": "Harriman House" },
  "identifiers": { "google_books_id": "…", "open_library_work_id": "OL21640039W", "open_library_edition_id": "OL…M" },
  "source": { "primary": "open_library", "sources": ["open_library", "google_books"] },
  "source_urls": ["https://openlibrary.org/works/OL21640039W", "…"],
  "field_sources": { "title": "open_library", "description": "google_books", "price": "google_books", "edition.front_image": "open_library" },
  "metadata": { "created_at": "…", "updated_at": "…" }
}
```

`images.back` is `null` unless a source actually provides a back cover. Fields that cannot be reliably obtained are
`null` or `[]`.

## Tests

```bash
npm test          # vitest: ISBN/text/price, genres/taxonomy/tags/popularity, HTTP retry/429/circuit breaker/cache,
                  # provider normalizers (real Open Library fixtures), robots/JSON-LD, dedupe/merge, validation,
                  # repository (idempotent upsert, precedence, price history, search), REST API + auth
npm run typecheck && npm run lint && npm run build
```

Fixtures are described in `tests/fixtures/README.md`. The Google Books and PA-API fixtures are hand-constructed from
the documented schemas and are clearly marked as such.

## Known limitations

* Without `GOOGLE_BOOKS_API_KEY` or Amazon credentials there are **no prices** (Open Library has none) and descriptions
  come from Open Library only. The pipeline reports these gaps (`books_missing_prices`) instead of filling them.
* Classification relies on source subjects. Open Library subjects are community-maintained, so some genre/tag
  choices are debatable. Tune `config/taxonomy.json` / `config/tags.json` and re-run offline.
* Indian-language coverage depends on what Open Library/Google Books hold. Some regional queries return few results.
* PostgreSQL repository is not implemented yet (interface in place).
