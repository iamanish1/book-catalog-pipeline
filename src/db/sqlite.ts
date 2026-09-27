import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SourcesConfig } from '../config/index.js';
import type { BookDto, ImageRef, MergedEdition, MergedWork, QualityIssue, SourceName } from '../domain/types.js';
import { isbn10To13, toIsbn13 } from '../lib/isbn.js';
import { authorKey, foldText, slugify, titleKey } from '../lib/text.js';
import { rankOf } from '../normalize/merge.js';
import type { CatalogRepository, CatalogStats, EditionDto, JobRecord, ListFilters, Page, UpsertResult } from './repository.js';
import { MIGRATIONS } from './schema.js';

type Row = Record<string, unknown>;
type Param = string | number | bigint | null | Uint8Array;

const J = (v: unknown) => JSON.stringify(v ?? null);
const P = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function openSqlite(databaseUrl: string): DatabaseSync {
  const file = databaseUrl.replace(/^file:/, '').replace(/^sqlite:/, '');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

export interface SqliteRepoOptions {
  sources: SourcesConfig;
  priceStaleMs: number;
}

export class SqliteCatalogRepository implements CatalogRepository {
  private txDepth = 0;

  constructor(
    readonly db: DatabaseSync,
    private readonly opts: SqliteRepoOptions,
  ) {}

  /* ------------------------------ plumbing ------------------------------ */

  private all(sql: string, ...params: Param[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private get(sql: string, ...params: Param[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private run(sql: string, ...params: Param[]) {
    return this.db.prepare(sql).run(...params);
  }

  /** Outermost call opens a transaction; nested calls use savepoints so an inner failure rolls back only its own writes. */
  transaction<T>(fn: () => T): T {
    const depth = this.txDepth;
    const sp = `sp_${depth}`;
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const out = fn();
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (e) {
      this.db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(this.all('SELECT version FROM schema_migrations').map((r) => Number(r.version)));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.transaction(() => {
        this.db.exec(m.sql);
        this.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', m.version, new Date().toISOString());
      });
    }
  }

  close(): void {
    this.db.close();
  }

  /* ---------------------------- reference data ---------------------------- */

  syncReferenceData(input: Parameters<CatalogRepository['syncReferenceData']>[0]): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      input.categories.forEach((c, ci) => {
        this.run(
          `INSERT INTO categories(name, slug, parent_id, position) VALUES (?, ?, NULL, ?)
           ON CONFLICT(COALESCE(parent_id, 0), slug) DO UPDATE SET name = excluded.name, position = excluded.position`,
          c.name,
          slugify(c.name),
          ci,
        );
        const parent = Number(this.get('SELECT id FROM categories WHERE parent_id IS NULL AND slug = ?', slugify(c.name))!.id);
        c.subcategories.forEach((s, si) => {
          this.run(
            `INSERT INTO categories(name, slug, parent_id, position) VALUES (?, ?, ?, ?)
             ON CONFLICT(COALESCE(parent_id, 0), slug) DO UPDATE SET name = excluded.name, position = excluded.position`,
            s.name,
            slugify(s.name),
            parent,
            si,
          );
        });
      });
      for (const g of input.genres) {
        this.run('INSERT INTO genres(name, slug) VALUES (?, ?) ON CONFLICT(name) DO NOTHING', g, slugify(g));
      }
      for (const s of input.sources) {
        this.run(
          `INSERT INTO data_sources(name, kind, base_url, terms_url, requires_key, enabled, disabled_reason, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET kind=excluded.kind, base_url=excluded.base_url, terms_url=excluded.terms_url,
             requires_key=excluded.requires_key, enabled=excluded.enabled, disabled_reason=excluded.disabled_reason, updated_at=excluded.updated_at`,
          s.name,
          s.kind,
          s.base_url,
          s.terms_url,
          s.requires_key ? 1 : 0,
          s.enabled ? 1 : 0,
          s.disabled_reason,
          now,
        );
      }
    });
  }

  private categoryId(category: string | null, subcategory: string | null): { cat: number | null; sub: number | null } {
    if (!category) return { cat: null, sub: null };
    const cat = this.get('SELECT id FROM categories WHERE parent_id IS NULL AND slug = ?', slugify(category));
    if (!cat) return { cat: null, sub: null };
    const sub = subcategory ? this.get('SELECT id FROM categories WHERE parent_id = ? AND slug = ?', Number(cat.id), slugify(subcategory)) : undefined;
    return { cat: Number(cat.id), sub: sub ? Number(sub.id) : null };
  }

  private idFor(table: 'genres' | 'tags', name: string): number {
    if (table === 'genres') {
      this.run('INSERT INTO genres(name, slug) VALUES (?, ?) ON CONFLICT(name) DO NOTHING', name, slugify(name));
    } else {
      this.run('INSERT INTO tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING', name);
    }
    return Number(this.get(`SELECT id FROM ${table} WHERE name = ?`, name)!.id);
  }

  private authorId(name: string): number | null {
    const key = authorKey(name);
    if (!key) return null;
    this.run('INSERT INTO authors(name, author_key, created_at) VALUES (?, ?, ?) ON CONFLICT(author_key) DO NOTHING', name, key, new Date().toISOString());
    return Number(this.get('SELECT id FROM authors WHERE author_key = ?', key)!.id);
  }

  /* -------------------------------- upsert -------------------------------- */

  private findEditionBook(e: MergedEdition): { book_id: string; edition_id: string; by: string } | null {
    const probes: Array<[string, string | null]> = [
      ['isbn_13', e.isbn_13],
      ['isbn_10', e.isbn_10],
      ['open_library_edition_id', e.identifiers.open_library_edition_id],
      ['google_books_id', e.identifiers.google_books_id],
      ['asin', e.identifiers.asin],
    ];
    for (const [col, val] of probes) {
      if (!val) continue;
      const r = this.get(`SELECT id, book_id FROM book_editions WHERE ${col} = ?`, val);
      if (r) return { book_id: String(r.book_id), edition_id: String(r.id), by: col };
    }
    return null;
  }

  /** DB-level dedup, in the priority order ISBN-13 → ISBN-10 → OL edition → GB id → OL work → title+author(+year). */
  private resolveExistingBook(work: MergedWork, conflicts: string[]): { id: string; by: string } | null {
    const votes = new Map<string, { n: number; by: string }>();
    for (const e of work.editions) {
      const hit = this.findEditionBook(e);
      if (!hit) continue;
      const v = votes.get(hit.book_id) ?? { n: 0, by: hit.by };
      v.n++;
      votes.set(hit.book_id, v);
    }
    if (votes.size > 1) conflicts.push(`editions of this work already belong to ${votes.size} different books: ${[...votes.keys()].join(', ')}`);
    const best = [...votes.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    if (best) return { id: best[0], by: best[1].by };
    if (work.identifiers.open_library_work_id) {
      const r = this.get('SELECT id FROM books WHERE open_library_work_id = ?', work.identifiers.open_library_work_id);
      if (r) return { id: String(r.id), by: 'open_library_work_id' };
    }
    const tk = titleKey(work.title);
    const ak = work.authors.map(authorKey).filter(Boolean).sort().join('|');
    if (tk && ak) {
      const rows = this.all('SELECT id, first_publication_year, open_library_work_id, field_sources FROM books WHERE title_key = ? AND author_key = ?', tk, ak);
      for (const r of rows) {
        // Two different Open Library works are not merged on title alone.
        if (r.open_library_work_id && work.identifiers.open_library_work_id && r.open_library_work_id !== work.identifiers.open_library_work_id) continue;
        const derived = (fs: Record<string, string>) => String(fs.first_publication_year ?? '').startsWith('derived');
        const y1 = num(r.first_publication_year);
        const y2 = work.first_publication_year;
        const yearsComparable = y1 !== null && y2 !== null && !derived(P(r.field_sources, {})) && !derived(work.field_sources);
        if (yearsComparable && Math.abs(y1 - y2) > 2) continue;
        return { id: String(r.id), by: 'title_author' };
      }
    }
    return null;
  }

  upsertWork(work: MergedWork, jobId: string | null): UpsertResult {
    return this.transaction(() => {
      const now = new Date().toISOString();
      const conflicts: string[] = [];
      const existing = this.resolveExistingBook(work, conflicts);
      const { cat, sub } = this.categoryId(work.category, work.subcategory);
      const tk = titleKey(work.title);
      const ak = work.authors.map(authorKey).filter(Boolean).sort().join('|');
      let bookId: string;
      let action: UpsertResult['action'];

      if (!existing) {
        bookId = crypto.randomUUID();
        action = 'inserted';
        this.run(
          `INSERT INTO books(id, title, subtitle, title_key, author_key, first_publication_year, description, short_description,
             category_id, subcategory_id, popularity_score, rating, ratings_count, popularity_source, popularity_detail,
             open_library_work_id, primary_source, sources, source_urls, field_sources, conflicts, genre_evidence,
             duplicate_probability, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          bookId,
          work.title,
          work.subtitle,
          tk,
          ak,
          work.first_publication_year,
          work.description,
          work.short_description,
          cat,
          sub,
          work.popularity.score,
          work.popularity.rating,
          work.popularity.ratings_count,
          work.popularity.popularity_source,
          J(work.popularity),
          work.identifiers.open_library_work_id,
          work.primary_source,
          J(work.sources),
          J(work.source_urls),
          J(work.field_sources),
          J(work.conflicts),
          J(work.genre_evidence),
          work.duplicate_probability,
          now,
          now,
        );
      } else {
        bookId = existing.id;
        action = 'updated';
        this.updateBook(bookId, work, cat, sub, now, conflicts);
      }

      // Authors / genres / tags reflect the latest full derivation for this work.
      if (work.authors.length) {
        this.run('DELETE FROM book_authors WHERE book_id = ?', bookId);
        const seen = new Set<number>();
        work.authors.forEach((a, i) => {
          const id = this.authorId(a);
          if (id !== null && !seen.has(id)) {
            seen.add(id);
            this.run('INSERT INTO book_authors(book_id, author_id, position) VALUES (?, ?, ?)', bookId, id, i);
          }
        });
      }
      if (work.genres.length) {
        this.run('DELETE FROM book_genres WHERE book_id = ?', bookId);
        work.genres.forEach((g, i) => this.run('INSERT INTO book_genres(book_id, genre_id, position) VALUES (?, ?, ?)', bookId, this.idFor('genres', g), i));
      }
      if (work.tags.length) {
        this.run('DELETE FROM book_tags WHERE book_id = ?', bookId);
        for (const t of work.tags) this.run('INSERT OR IGNORE INTO book_tags(book_id, tag_id) VALUES (?, ?)', bookId, this.idFor('tags', t));
      }

      let editionsInserted = 0;
      let editionsUpdated = 0;
      let pricesChanged = 0;
      for (const e of work.editions) {
        const r = this.upsertEdition(bookId, e, now, conflicts);
        if (r.action === 'inserted') editionsInserted++;
        else if (r.action === 'updated') editionsUpdated++;
        pricesChanged += r.pricesChanged;
        if (r.editionId) {
          for (const ref of e.record_refs) {
            this.run(
              `INSERT INTO source_records(book_id, edition_id, record_ref, source, retrieved_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?)
               ON CONFLICT(record_ref) DO UPDATE SET book_id = excluded.book_id, edition_id = excluded.edition_id, updated_at = excluded.updated_at`,
              bookId,
              r.editionId,
              ref,
              ref.split(':')[0]!,
              now,
            );
          }
        }
      }
      if (work.identifiers.open_library_work_id) {
        this.run(
          `INSERT INTO source_records(book_id, edition_id, record_ref, source, retrieved_at, updated_at) VALUES (?, NULL, ?, 'open_library', NULL, ?)
           ON CONFLICT(record_ref) DO UPDATE SET book_id = excluded.book_id, updated_at = excluded.updated_at`,
          bookId,
          `open_library:work:${work.identifiers.open_library_work_id}`,
          now,
        );
      }
      for (const c of work.duplicate_candidates) {
        this.run(
          `INSERT INTO dedupe_candidates(book_id, other_key, other_title, similarity, reason, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)
           ON CONFLICT(book_id, other_key) DO UPDATE SET similarity = excluded.similarity, reason = excluded.reason`,
          bookId,
          c.other_key,
          c.other_title,
          c.similarity,
          c.reason,
          now,
        );
      }
      this.refreshPrimaryEdition(bookId);
      this.refreshSearchIndex(bookId);
      if (conflicts.length) {
        this.recordQualityIssues(
          jobId,
          'import',
          work.key,
          work.title,
          conflicts.map((m) => ({ field: 'identity', code: 'merge_conflict', message: m, severity: 'warning' })),
        );
      }
      return {
        book_id: bookId,
        action,
        matched_by: existing?.by ?? null,
        editions_inserted: editionsInserted,
        editions_updated: editionsUpdated,
        prices_changed: pricesChanged,
        conflicts,
      };
    });
  }

  /** Precedence-aware update: a lower-priority source never overwrites a higher-priority one. */
  private updateBook(bookId: string, work: MergedWork, cat: number | null, sub: number | null, now: string, conflicts: string[]): void {
    const cur = this.get('SELECT * FROM books WHERE id = ?', bookId)!;
    const fieldSources = P<Record<string, string>>(cur.field_sources, {});
    const storedConflicts = P<unknown[]>(cur.conflicts, []);
    const wp = this.opts.sources.work_precedence;
    const set: Record<string, Param> = {};
    const consider = (field: string, column: string, value: Param, precKey: string) => {
      if (value === null) return;
      const newSrc = work.field_sources[field];
      const oldSrc = fieldSources[field];
      const oldVal = cur[column] as Param;
      if (oldVal === null || oldVal === undefined || !oldSrc || (newSrc && rankOf(wp[precKey], newSrc) <= rankOf(wp[precKey], oldSrc))) {
        set[column] = value;
        if (newSrc) fieldSources[field] = newSrc;
      } else if (String(oldVal) !== String(value)) {
        storedConflicts.push({ field, chosen: { source: oldSrc, value: oldVal }, alternatives: [{ source: newSrc ?? 'unknown', value }] });
        conflicts.push(`${field}: kept ${oldSrc} value over ${newSrc ?? 'unknown'}`);
      }
    };
    consider('title', 'title', work.title, 'title');
    consider('subtitle', 'subtitle', work.subtitle, 'title');
    consider('first_publication_year', 'first_publication_year', work.first_publication_year, 'first_publication_year');
    consider('description', 'description', work.description, 'description');
    if (set.description !== undefined) set.short_description = work.short_description;
    if (set.title !== undefined) set.title_key = titleKey(String(set.title));
    if (!cur.open_library_work_id && work.identifiers.open_library_work_id) set.open_library_work_id = work.identifiers.open_library_work_id;
    // Derived fields: latest derivation wins, but never replace a value with "unknown".
    if (cat !== null) {
      set.category_id = cat;
      set.subcategory_id = sub;
    }
    if (work.popularity.score !== null) {
      set.popularity_score = work.popularity.score;
      set.rating = work.popularity.rating;
      set.ratings_count = work.popularity.ratings_count;
      set.popularity_source = work.popularity.popularity_source;
      set.popularity_detail = J(work.popularity);
    }
    const sources = [...new Set([...P<string[]>(cur.sources, []), ...work.sources])];
    const urls = [...new Set([...P<string[]>(cur.source_urls, []), ...work.source_urls])];
    set.sources = J(sources);
    set.source_urls = J(urls);
    set.field_sources = J(fieldSources);
    set.conflicts = J([...storedConflicts, ...work.conflicts].slice(-100));
    if (work.genre_evidence.length) set.genre_evidence = J(work.genre_evidence);
    set.duplicate_probability = work.duplicate_probability;
    set.updated_at = now;
    const cols = Object.keys(set);
    this.run(`UPDATE books SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => set[c]!), bookId);
  }

  private upsertEdition(
    bookId: string,
    e: MergedEdition,
    now: string,
    conflicts: string[],
  ): { action: 'inserted' | 'updated' | 'skipped'; editionId: string | null; pricesChanged: number } {
    const hit = this.findEditionBook(e);
    let editionId: string;
    let action: 'inserted' | 'updated';
    if (hit && hit.book_id !== bookId) {
      conflicts.push(`edition ${e.key} already belongs to book ${hit.book_id}; not moved`);
      return { action: 'skipped', editionId: null, pricesChanged: 0 };
    }
    if (!hit) {
      editionId = crypto.randomUUID();
      action = 'inserted';
      this.run(
        `INSERT INTO book_editions(id, book_id, title, subtitle, isbn_10, isbn_13, publisher, publication_year, language, page_count, format,
           edition_name, google_books_id, open_library_edition_id, asin, sources, source_urls, field_sources, conflicts, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        editionId,
        bookId,
        e.title,
        e.subtitle,
        e.isbn_10,
        e.isbn_13,
        e.publisher,
        e.publication_year,
        e.language,
        e.page_count,
        e.format,
        e.edition_name,
        e.identifiers.google_books_id,
        e.identifiers.open_library_edition_id,
        e.identifiers.asin,
        J(e.sources),
        J(e.source_urls),
        J(e.field_sources),
        J(e.conflicts),
        now,
        now,
      );
    } else {
      editionId = hit.edition_id;
      action = 'updated';
      const cur = this.get('SELECT * FROM book_editions WHERE id = ?', editionId)!;
      const fsrc = P<Record<string, string>>(cur.field_sources, {});
      const ep = this.opts.sources.edition_precedence;
      const set: Record<string, Param> = {};
      const fields: Array<[keyof MergedEdition & string, string, string]> = [
        ['title', 'title', 'title'],
        ['subtitle', 'subtitle', 'title'],
        ['publisher', 'publisher', 'publisher'],
        ['publication_year', 'publication_year', 'publication_year'],
        ['language', 'language', 'language'],
        ['page_count', 'page_count', 'page_count'],
        ['format', 'format', 'format'],
        ['edition_name', 'edition_name', 'edition_name'],
      ];
      for (const [field, col, prec] of fields) {
        const v = e[field] as Param;
        if (v === null || v === undefined) continue;
        const newSrc = e.field_sources[field] as SourceName | undefined;
        const oldSrc = fsrc[field];
        if (cur[col] === null || !oldSrc || (newSrc && rankOf(ep[prec], newSrc) <= rankOf(ep[prec], oldSrc))) {
          set[col] = v;
          if (newSrc) fsrc[field] = newSrc;
        } else if (String(cur[col]) !== String(v)) {
          conflicts.push(`edition ${e.key} ${field}: kept ${oldSrc} value`);
        }
      }
      // Identifiers only fill gaps; an existing identifier is never replaced.
      for (const [col, v] of [
        ['isbn_13', e.isbn_13],
        ['isbn_10', e.isbn_10],
        ['google_books_id', e.identifiers.google_books_id],
        ['open_library_edition_id', e.identifiers.open_library_edition_id],
        ['asin', e.identifiers.asin],
      ] as const) {
        if (!v) continue;
        if (cur[col] === null) {
          const taken = this.get(`SELECT id FROM book_editions WHERE ${col} = ? AND id <> ?`, v, editionId);
          if (!taken) set[col] = v;
          else conflicts.push(`edition ${e.key}: ${col} ${v} already used by another edition`);
        } else if (cur[col] !== v) conflicts.push(`edition ${e.key}: ${col} differs (${String(cur[col])} vs ${v}); kept existing`);
      }
      set.sources = J([...new Set([...P<string[]>(cur.sources, []), ...e.sources])]);
      set.source_urls = J([...new Set([...P<string[]>(cur.source_urls, []), ...e.source_urls])]);
      set.field_sources = J(fsrc);
      set.conflicts = J([...P<unknown[]>(cur.conflicts, []), ...e.conflicts].slice(-50));
      set.updated_at = now;
      const cols = Object.keys(set);
      this.run(`UPDATE book_editions SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => set[c]!), editionId);
    }

    e.images.forEach((img, i) => {
      this.run(
        `INSERT INTO edition_images(edition_id, kind, url, source, license, reachable, content_type, retrieved_at, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(edition_id, url) DO UPDATE SET reachable = excluded.reachable, content_type = excluded.content_type,
           retrieved_at = excluded.retrieved_at, position = excluded.position, license = COALESCE(excluded.license, edition_images.license)`,
        editionId,
        img.kind,
        img.url,
        img.source,
        img.license,
        img.reachable === undefined || img.reachable === null ? null : img.reachable ? 1 : 0,
        img.content_type ?? null,
        img.retrieved_at,
        i,
      );
    });

    let pricesChanged = 0;
    for (const o of e.offers) {
      const cur = this.get(
        `SELECT id, amount, currency, retrieved_at FROM edition_prices
         WHERE edition_id = ? AND source = ? AND COALESCE(offer_format, '') = ? AND is_current = 1`,
        editionId,
        o.source,
        o.offer_format ?? '',
      );
      if (cur && Number(cur.amount) === o.amount && cur.currency === o.currency) {
        if (Date.parse(o.retrieved_at) > Date.parse(String(cur.retrieved_at))) {
          this.run('UPDATE edition_prices SET retrieved_at = ?, buy_url = COALESCE(?, buy_url) WHERE id = ?', o.retrieved_at, o.buy_url, Number(cur.id));
        }
        continue;
      }
      if (cur && Date.parse(o.retrieved_at) <= Date.parse(String(cur.retrieved_at))) continue; // older observation
      if (cur) this.run('UPDATE edition_prices SET is_current = 0 WHERE id = ?', Number(cur.id));
      this.run(
        `INSERT INTO edition_prices(edition_id, amount, currency, source, offer_format, buy_url, raw, retrieved_at, first_seen_at, is_current)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        editionId,
        o.amount,
        o.currency,
        o.source,
        o.offer_format,
        o.buy_url,
        o.raw,
        o.retrieved_at,
        now,
      );
      pricesChanged++;
    }
    return { action, editionId, pricesChanged };
  }

  private refreshPrimaryEdition(bookId: string): void {
    const rows = this.all(
      `SELECT e.id, e.isbn_13, e.publisher, e.format, e.page_count, e.language, e.publication_year,
         (SELECT COUNT(*) FROM edition_prices p WHERE p.edition_id = e.id AND p.is_current = 1) AS offers,
         (SELECT COUNT(*) FROM edition_images i WHERE i.edition_id = e.id AND i.kind = 'front' AND COALESCE(i.reachable, 1) = 1) AS images
       FROM book_editions e WHERE e.book_id = ?`,
      bookId,
    );
    let best: { id: string; s: number } | null = null;
    for (const r of rows) {
      let s = 0;
      if (Number(r.offers) > 0) s += 4;
      if (Number(r.images) > 0) s += 3;
      if (r.isbn_13) s += 2;
      if (r.publisher) s += 1;
      if (r.format && r.format !== 'eBook') s += 1;
      if (r.page_count) s += 0.5;
      if (r.language === 'en') s += 0.25;
      s += (num(r.publication_year) ?? 1900) / 100000;
      if (!best || s > best.s) best = { id: String(r.id), s };
    }
    this.run('UPDATE books SET primary_edition_id = ? WHERE id = ?', best?.id ?? null, bookId);
  }

  private refreshSearchIndex(bookId: string): void {
    const b = this.get(
      `SELECT b.title, b.subtitle, c.name AS category, s.name AS subcategory FROM books b
       LEFT JOIN categories c ON c.id = b.category_id LEFT JOIN categories s ON s.id = b.subcategory_id WHERE b.id = ?`,
      bookId,
    )!;
    const authors = this.all('SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = ? ORDER BY ba.position', bookId).map((r) => r.name);
    const eds = this.all('SELECT isbn_10, isbn_13, publisher FROM book_editions WHERE book_id = ?', bookId);
    const genres = this.all('SELECT g.name FROM book_genres bg JOIN genres g ON g.id = bg.genre_id WHERE bg.book_id = ?', bookId).map((r) => r.name);
    const tags = this.all('SELECT t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.book_id = ?', bookId).map((r) => r.name);
    this.run('DELETE FROM books_fts WHERE book_id = ?', bookId);
    this.run(
      'INSERT INTO books_fts(book_id, title, authors, isbns, publisher, category, genres, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      bookId,
      [b.title, b.subtitle].filter(Boolean).join(' '),
      authors.join(' ; '),
      eds.flatMap((e) => [e.isbn_13, e.isbn_10]).filter(Boolean).join(' '),
      [...new Set(eds.map((e) => e.publisher).filter(Boolean))].join(' ; '),
      [b.category, b.subcategory].filter(Boolean).join(' ; '),
      genres.join(' ; '),
      tags.join(' ; '),
    );
  }

  recordQualityIssues(jobId: string | null, stage: string, recordKey: string, title: string | null, issues: QualityIssue[]): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'INSERT INTO data_quality_errors(job_id, stage, record_key, title, severity, code, field, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const i of issues) stmt.run(jobId, stage, recordKey, title, i.severity, i.code, i.field, i.message, now);
  }

  /* -------------------------------- reads -------------------------------- */

  private filterSql(f: ListFilters): { where: string[]; params: Param[] } {
    const where: string[] = [];
    const params: Param[] = [];
    if (f.category) {
      where.push('b.category_id IN (SELECT id FROM categories WHERE parent_id IS NULL AND (slug = ? OR name = ? COLLATE NOCASE))');
      params.push(slugify(f.category), f.category);
    }
    if (f.subcategory) {
      where.push('b.subcategory_id IN (SELECT id FROM categories WHERE parent_id IS NOT NULL AND (slug = ? OR name = ? COLLATE NOCASE))');
      params.push(slugify(f.subcategory), f.subcategory);
    }
    if (f.genre) {
      where.push('EXISTS (SELECT 1 FROM book_genres bg JOIN genres g ON g.id = bg.genre_id WHERE bg.book_id = b.id AND (g.slug = ? OR g.name = ? COLLATE NOCASE))');
      params.push(slugify(f.genre), f.genre);
    }
    if (f.tag) {
      where.push('EXISTS (SELECT 1 FROM book_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.book_id = b.id AND t.name = ?)');
      params.push(foldText(f.tag));
    }
    if (f.author) {
      where.push('EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id AND (a.author_key = ? OR a.name = ? COLLATE NOCASE))');
      params.push(authorKey(f.author), f.author);
    }
    if (f.publisher) {
      where.push('EXISTS (SELECT 1 FROM book_editions e WHERE e.book_id = b.id AND e.publisher = ? COLLATE NOCASE)');
      params.push(f.publisher);
    }
    if (f.language) {
      where.push('EXISTS (SELECT 1 FROM book_editions e WHERE e.book_id = b.id AND e.language = ?)');
      params.push(f.language);
    }
    if (f.yearFrom !== undefined) {
      where.push('b.first_publication_year >= ?');
      params.push(f.yearFrom);
    }
    if (f.yearTo !== undefined) {
      where.push('b.first_publication_year <= ?');
      params.push(f.yearTo);
    }
    if (f.hasPrice) where.push('EXISTS (SELECT 1 FROM edition_prices p WHERE p.edition_id = b.primary_edition_id AND p.is_current = 1)');
    return { where, params };
  }

  private page<T>(items: T[], page: number, limit: number, total: number): Page<T> {
    return { items, page, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)) };
  }

  listBooks(filters: ListFilters, page: number, limit: number): Page<BookDto> {
    const { where, params } = this.filterSql(filters);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order =
      filters.sort === 'title'
        ? 'b.title COLLATE NOCASE ASC'
        : filters.sort === 'year'
          ? 'b.first_publication_year DESC NULLS LAST'
          : filters.sort === 'recent'
            ? 'b.updated_at DESC'
            : 'b.popularity_score DESC NULLS LAST, b.title COLLATE NOCASE';
    const total = Number(this.get(`SELECT COUNT(*) AS n FROM books b ${w}`, ...params)!.n);
    const ids = this.all(`SELECT b.id FROM books b ${w} ORDER BY ${order}, b.id LIMIT ? OFFSET ?`, ...params, limit, (page - 1) * limit).map((r) => String(r.id));
    return this.page(this.hydrate(ids), page, limit, total);
  }

  getBook(id: string): BookDto | null {
    return this.hydrate([id])[0] ?? null;
  }

  getBookByIsbn(isbn: string): BookDto | null {
    const isbn13 = toIsbn13(isbn);
    if (!isbn13) return null;
    const r = this.get('SELECT id, book_id FROM book_editions WHERE isbn_13 = ?', isbn13);
    if (!r) return null;
    return this.hydrate([String(r.book_id)], new Map([[String(r.book_id), String(r.id)]]))[0] ?? null;
  }

  search(q: string, page: number, limit: number, filters: ListFilters = {}): Page<BookDto & { relevance: number }> {
    const query = q.trim();
    if (!query) return this.page([], page, limit, 0);
    const isbn13 = toIsbn13(query) ?? (query.replace(/[\s-]/g, '').length === 10 ? isbn10To13(query) : null);
    const tokens = foldText(query).split(' ').filter((t) => t.length > 0).slice(0, 12);
    if (tokens.length === 0 && !isbn13) return this.page([], page, limit, 0);
    const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;
    const andMatch = tokens.map((t, i) => (i === tokens.length - 1 ? `${quote(t)}*` : quote(t))).join(' ');
    const orMatch = tokens.map((t) => `${quote(t)}*`).join(' OR ');
    const { where, params } = this.filterSql(filters);
    const extra = where.length ? `AND ${where.join(' AND ')}` : '';
    const tk = titleKey(query);
    const ak = authorKey(query);

    const run = (match: string) => {
      const sql = `
        WITH m AS (
          SELECT book_id, bm25(books_fts, 0.0, 10.0, 6.0, 8.0, 2.0, 1.5, 2.0, 2.0) AS r FROM books_fts WHERE books_fts MATCH ?
          UNION ALL
          SELECT e.book_id, -1000.0 FROM book_editions e WHERE e.isbn_13 = ?
        ), best AS (SELECT book_id, MIN(r) AS r FROM m GROUP BY book_id)
        SELECT b.id,
          (CASE WHEN EXISTS (SELECT 1 FROM book_editions e WHERE e.book_id = b.id AND e.isbn_13 = ?) THEN 1000 ELSE 0 END)
          + (CASE WHEN lower(b.title) = lower(?) THEN 120 WHEN b.title_key = ? THEN 100 WHEN b.title_key LIKE ? THEN 30 ELSE 0 END)
          + (CASE WHEN EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                 WHERE ba.book_id = b.id AND (a.author_key = ? OR a.name = ? COLLATE NOCASE)) THEN 60 ELSE 0 END)
          + MIN(-best.r, 1000) * 3
          + COALESCE(b.popularity_score, 0) * 0.3 AS relevance
        FROM best JOIN books b ON b.id = best.book_id
        WHERE 1 = 1 ${extra}
        ORDER BY relevance DESC, b.popularity_score DESC NULLS LAST, b.id`;
      return this.all(sql, match, isbn13 ?? '', isbn13 ?? '', query, tk, `${tk}%`, ak, query, ...params);
    };
    let rows: Row[];
    try {
      rows = tokens.length ? run(andMatch) : run('"__no_tokens__"');
      if (rows.length === 0 && tokens.length > 1) rows = run(orMatch);
    } catch {
      rows = [];
    }
    const total = rows.length;
    const slice = rows.slice((page - 1) * limit, page * limit);
    const rel = new Map(slice.map((r) => [String(r.id), Math.round(Number(r.relevance) * 100) / 100]));
    const items = this.hydrate(slice.map((r) => String(r.id))).map((b) => ({ ...b, relevance: rel.get(b.id) ?? 0 }));
    return this.page(items, page, limit, total);
  }

  listEditions(bookId: string, page: number, limit: number): Page<EditionDto> | null {
    const book = this.get('SELECT primary_edition_id FROM books WHERE id = ?', bookId);
    if (!book) return null;
    const total = Number(this.get('SELECT COUNT(*) AS n FROM book_editions WHERE book_id = ?', bookId)!.n);
    const rows = this.all(
      `SELECT * FROM book_editions WHERE book_id = ? ORDER BY (id = ?) DESC, publication_year DESC NULLS LAST, id LIMIT ? OFFSET ?`,
      bookId,
      strOrNull(book.primary_edition_id) ?? '',
      limit,
      (page - 1) * limit,
    );
    const ids = rows.map((r) => String(r.id));
    const offers = this.offersFor(ids);
    const images = this.imagesFor(ids);
    const items = rows.map((r): EditionDto => {
      const id = String(r.id);
      const o = offers.get(id) ?? [];
      const best = this.bestOffer(o, strOrNull(r.format));
      const imgs = images.get(id) ?? [];
      return {
        id,
        title: String(r.title),
        subtitle: strOrNull(r.subtitle),
        isbn_10: strOrNull(r.isbn_10),
        isbn_13: strOrNull(r.isbn_13),
        publisher: strOrNull(r.publisher),
        publication_year: num(r.publication_year),
        language: strOrNull(r.language),
        page_count: num(r.page_count),
        format: strOrNull(r.format),
        edition_name: strOrNull(r.edition_name),
        identifiers: { google_books_id: strOrNull(r.google_books_id), open_library_edition_id: strOrNull(r.open_library_edition_id), asin: strOrNull(r.asin) },
        price: best ? { amount: best.amount, currency: best.currency } : null,
        price_metadata: best ? this.priceMeta(best) : null,
        offers: o.map((x) => ({ amount: x.amount, currency: x.currency, source: x.source, offer_format: x.offer_format, buy_url: x.buy_url, retrieved_at: x.retrieved_at })),
        ...this.imageFields(imgs),
        sources: P(r.sources, []),
        source_urls: P(r.source_urls, []),
        field_sources: P(r.field_sources, {}),
        is_primary: id === strOrNull(book.primary_edition_id),
      };
    });
    return this.page(items, page, limit, total);
  }

  private offersFor(editionIds: string[]): Map<string, Array<{ amount: number; currency: string; source: string; offer_format: string | null; buy_url: string | null; retrieved_at: string }>> {
    const out = new Map<string, Array<{ amount: number; currency: string; source: string; offer_format: string | null; buy_url: string | null; retrieved_at: string }>>();
    if (!editionIds.length) return out;
    const rows = this.all(
      `SELECT edition_id, amount, currency, source, offer_format, buy_url, retrieved_at FROM edition_prices
       WHERE is_current = 1 AND edition_id IN (${editionIds.map(() => '?').join(',')})`,
      ...editionIds,
    );
    for (const r of rows) {
      const k = String(r.edition_id);
      out.set(k, [
        ...(out.get(k) ?? []),
        { amount: Number(r.amount), currency: String(r.currency), source: String(r.source), offer_format: strOrNull(r.offer_format), buy_url: strOrNull(r.buy_url), retrieved_at: String(r.retrieved_at) },
      ]);
    }
    return out;
  }

  private imagesFor(editionIds: string[]): Map<string, ImageRef[]> {
    const out = new Map<string, ImageRef[]>();
    if (!editionIds.length) return out;
    const rows = this.all(
      `SELECT edition_id, kind, url, source, license, reachable, content_type, retrieved_at FROM edition_images
       WHERE COALESCE(reachable, 1) = 1 AND edition_id IN (${editionIds.map(() => '?').join(',')}) ORDER BY position`,
      ...editionIds,
    );
    for (const r of rows) {
      const k = String(r.edition_id);
      out.set(k, [
        ...(out.get(k) ?? []),
        {
          kind: r.kind as 'front' | 'back',
          url: String(r.url),
          source: String(r.source),
          license: strOrNull(r.license),
          reachable: r.reachable === null ? null : Number(r.reachable) === 1,
          content_type: strOrNull(r.content_type),
          retrieved_at: String(r.retrieved_at),
        },
      ]);
    }
    return out;
  }

  /** Prefer the offer for the same format as the edition, then by price-source precedence. */
  private bestOffer<T extends { source: string; offer_format: string | null }>(offers: T[], editionFormat: string | null): T | null {
    if (!offers.length) return null;
    const prec = this.opts.sources.edition_precedence.price;
    return [...offers].sort((a, b) => {
      const fa = a.offer_format === editionFormat || a.offer_format === null ? 0 : 1;
      const fb = b.offer_format === editionFormat || b.offer_format === null ? 0 : 1;
      return fa - fb || rankOf(prec, a.source) - rankOf(prec, b.source);
    })[0]!;
  }

  private priceMeta(o: { source: string; retrieved_at: string; offer_format: string | null; buy_url: string | null }): NonNullable<BookDto['price_metadata']> {
    return {
      source: o.source,
      retrieved_at: o.retrieved_at,
      offer_format: o.offer_format,
      buy_url: o.buy_url,
      is_stale: Date.now() - Date.parse(o.retrieved_at) > this.opts.priceStaleMs,
    };
  }

  private imageFields(imgs: ImageRef[]): Pick<BookDto, 'images' | 'image_metadata'> {
    const front = imgs.find((i) => i.kind === 'front') ?? null;
    const back = imgs.find((i) => i.kind === 'back') ?? null;
    const meta = (i: ImageRef | null) => (i ? { url: i.url, source: i.source, license: i.license, retrieved_at: i.retrieved_at, reachable: i.reachable ?? null, content_type: i.content_type ?? null } : null);
    return { images: { front: front?.url ?? null, back: back?.url ?? null }, image_metadata: { front: meta(front), back: meta(back) } };
  }

  /** Assemble BookDto objects for ids (order preserved), batching the related lookups. */
  private hydrate(ids: string[], editionOverride = new Map<string, string>()): BookDto[] {
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    const books = new Map(
      this.all(
        `SELECT b.*, c.name AS category_name, s.name AS subcategory_name,
           (SELECT COUNT(*) FROM book_editions e WHERE e.book_id = b.id) AS editions_count
         FROM books b LEFT JOIN categories c ON c.id = b.category_id LEFT JOIN categories s ON s.id = b.subcategory_id
         WHERE b.id IN (${ph})`,
        ...ids,
      ).map((r) => [String(r.id), r]),
    );
    const authors = new Map<string, string[]>();
    for (const r of this.all(`SELECT ba.book_id, a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id IN (${ph}) ORDER BY ba.position`, ...ids)) {
      authors.set(String(r.book_id), [...(authors.get(String(r.book_id)) ?? []), String(r.name)]);
    }
    const genres = new Map<string, string[]>();
    for (const r of this.all(`SELECT bg.book_id, g.name FROM book_genres bg JOIN genres g ON g.id = bg.genre_id WHERE bg.book_id IN (${ph}) ORDER BY bg.position`, ...ids)) {
      genres.set(String(r.book_id), [...(genres.get(String(r.book_id)) ?? []), String(r.name)]);
    }
    const tags = new Map<string, string[]>();
    for (const r of this.all(`SELECT bt.book_id, t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.book_id IN (${ph}) ORDER BY t.name`, ...ids)) {
      tags.set(String(r.book_id), [...(tags.get(String(r.book_id)) ?? []), String(r.name)]);
    }
    const editionIds = ids.map((id) => editionOverride.get(id) ?? strOrNull(books.get(id)?.primary_edition_id)).filter((x): x is string => !!x);
    const editions = new Map(
      editionIds.length ? this.all(`SELECT * FROM book_editions WHERE id IN (${editionIds.map(() => '?').join(',')})`, ...editionIds).map((r) => [String(r.id), r]) : [],
    );
    const offers = this.offersFor(editionIds);
    const images = this.imagesFor(editionIds);

    const out: BookDto[] = [];
    for (const id of ids) {
      const b = books.get(id);
      if (!b) continue;
      const edId = editionOverride.get(id) ?? strOrNull(b.primary_edition_id);
      const e = edId ? editions.get(edId) : undefined;
      const best = e ? this.bestOffer(offers.get(edId!) ?? [], strOrNull(e.format)) : null;
      const pop = P<{ score: number | null }>(b.popularity_detail, { score: null });
      const bookFs = P<Record<string, string>>(b.field_sources, {});
      const edFs = e ? P<Record<string, string>>(e.field_sources, {}) : {};
      const fieldSources: Record<string, string> = { ...bookFs };
      for (const k of ['isbn_13', 'publisher', 'publication_year', 'language', 'page_count', 'format', 'front_image']) if (edFs[k]) fieldSources[`edition.${k}`] = edFs[k]!;
      if (best) fieldSources.price = best.source;
      const sources = P<string[]>(b.sources, []);
      out.push({
        id,
        title: String(b.title),
        subtitle: strOrNull(b.subtitle),
        authors: authors.get(id) ?? [],
        publication_year: num(b.first_publication_year),
        genre: genres.get(id) ?? [],
        popularity: {
          score: num(b.popularity_score) ?? pop.score,
          rating: num(b.rating),
          ratings_count: num(b.ratings_count),
          popularity_source: strOrNull(b.popularity_source) ?? 'internal_normalized_score',
        },
        price: best ? { amount: best.amount, currency: best.currency } : null,
        price_metadata: best ? this.priceMeta(best) : null,
        short_description: strOrNull(b.short_description),
        ...this.imageFields(edId ? images.get(edId) ?? [] : []),
        tags: tags.get(id) ?? [],
        category: strOrNull(b.category_name),
        subcategory: strOrNull(b.subcategory_name),
        isbn_10: e ? strOrNull(e.isbn_10) : null,
        isbn_13: e ? strOrNull(e.isbn_13) : null,
        publisher: e ? strOrNull(e.publisher) : null,
        language: e ? strOrNull(e.language) : null,
        page_count: e ? num(e.page_count) : null,
        edition: e
          ? { id: String(e.id), edition_name: strOrNull(e.edition_name), edition_year: num(e.publication_year), format: strOrNull(e.format), publisher: strOrNull(e.publisher) }
          : null,
        editions_count: Number(b.editions_count),
        identifiers: {
          google_books_id: e ? strOrNull(e.google_books_id) : null,
          open_library_work_id: strOrNull(b.open_library_work_id),
          open_library_edition_id: e ? strOrNull(e.open_library_edition_id) : null,
        },
        source: { primary: String(b.primary_source), sources },
        source_urls: P<string[]>(b.source_urls, []),
        field_sources: fieldSources,
        metadata: { created_at: String(b.created_at), updated_at: String(b.updated_at) },
      });
    }
    return out;
  }

  categoriesWithCounts(): ReturnType<CatalogRepository['categoriesWithCounts']> {
    const cats = this.all(
      `SELECT c.id, c.name, c.slug, (SELECT COUNT(*) FROM books b WHERE b.category_id = c.id) AS n FROM categories c WHERE c.parent_id IS NULL ORDER BY c.position`,
    );
    return cats.map((c) => ({
      name: String(c.name),
      slug: String(c.slug),
      books: Number(c.n),
      subcategories: this.all(
        `SELECT s.name, s.slug, (SELECT COUNT(*) FROM books b WHERE b.subcategory_id = s.id) AS n FROM categories s WHERE s.parent_id = ? ORDER BY s.position`,
        Number(c.id),
      ).map((s) => ({ name: String(s.name), slug: String(s.slug), books: Number(s.n) })),
    }));
  }

  genresWithCounts(): ReturnType<CatalogRepository['genresWithCounts']> {
    return this.all(`SELECT g.name, g.slug, (SELECT COUNT(*) FROM book_genres bg WHERE bg.genre_id = g.id) AS n FROM genres g ORDER BY n DESC, g.name`).map((g) => ({
      name: String(g.name),
      slug: String(g.slug),
      books: Number(g.n),
    }));
  }

  /* --------------------------------- jobs --------------------------------- */

  startJob(jobId: string, kind: string, params: Record<string, unknown>): void {
    this.run(`INSERT INTO import_jobs(job_id, kind, status, params, started_at) VALUES (?, ?, 'running', ?, ?)`, jobId, kind, J(params), new Date().toISOString());
  }

  finishJob(jobId: string, status: 'completed' | 'failed', stats: Record<string, unknown>, error: string | null = null): void {
    this.run('UPDATE import_jobs SET status = ?, stats = ?, error = ?, completed_at = ? WHERE job_id = ?', status, J(stats), error, new Date().toISOString(), jobId);
  }

  private jobFromRow(r: Row): JobRecord {
    return {
      job_id: String(r.job_id),
      kind: String(r.kind),
      status: r.status as JobRecord['status'],
      params: P(r.params, {}),
      stats: P(r.stats, {}),
      error: strOrNull(r.error),
      started_at: String(r.started_at),
      completed_at: strOrNull(r.completed_at),
    };
  }

  getJob(jobId: string): JobRecord | null {
    const r = this.get('SELECT * FROM import_jobs WHERE job_id = ?', jobId);
    return r ? this.jobFromRow(r) : null;
  }

  stats(): CatalogStats {
    const n = (sql: string) => Number(this.get(sql)!.n);
    const recent = this.all('SELECT * FROM import_jobs ORDER BY started_at DESC LIMIT 10').map((r) => this.jobFromRow(r));
    return {
      books: n('SELECT COUNT(*) AS n FROM books'),
      editions: n('SELECT COUNT(*) AS n FROM book_editions'),
      authors: n('SELECT COUNT(*) AS n FROM authors'),
      books_missing_images: n(
        `SELECT COUNT(*) AS n FROM books b WHERE NOT EXISTS (SELECT 1 FROM book_editions e JOIN edition_images i ON i.edition_id = e.id
           WHERE e.book_id = b.id AND i.kind = 'front' AND COALESCE(i.reachable, 1) = 1)`,
      ),
      books_missing_prices: n(
        'SELECT COUNT(*) AS n FROM books b WHERE NOT EXISTS (SELECT 1 FROM book_editions e JOIN edition_prices p ON p.edition_id = e.id WHERE e.book_id = b.id AND p.is_current = 1)',
      ),
      books_missing_isbn: n('SELECT COUNT(*) AS n FROM books b WHERE NOT EXISTS (SELECT 1 FROM book_editions e WHERE e.book_id = b.id AND e.isbn_13 IS NOT NULL)'),
      books_unclassified: n('SELECT COUNT(*) AS n FROM books WHERE category_id IS NULL'),
      dedupe_candidates_pending: n(`SELECT COUNT(*) AS n FROM dedupe_candidates WHERE status = 'pending'`),
      quality_errors: n(`SELECT COUNT(*) AS n FROM data_quality_errors WHERE severity = 'error'`),
      quality_warnings: n(`SELECT COUNT(*) AS n FROM data_quality_errors WHERE severity = 'warning'`),
      source_distribution: this.all('SELECT source, COUNT(DISTINCT book_id) AS n FROM source_records GROUP BY source ORDER BY n DESC').map((r) => ({
        source: String(r.source),
        books: Number(r.n),
      })),
      category_distribution: this.all(
        'SELECT c.name, COUNT(*) AS n FROM books b LEFT JOIN categories c ON c.id = b.category_id GROUP BY c.name ORDER BY n DESC',
      ).map((r) => ({ category: strOrNull(r.name), books: Number(r.n) })),
      last_import: recent.find((j) => j.kind !== 'stage') ?? recent[0] ?? null,
      recent_jobs: recent,
    };
  }

  qualityErrors(page: number, limit: number, severity?: 'error' | 'warning'): Page<Record<string, unknown>> {
    const where = severity ? 'WHERE severity = ?' : '';
    const params: Param[] = severity ? [severity] : [];
    const total = Number(this.get(`SELECT COUNT(*) AS n FROM data_quality_errors ${where}`, ...params)!.n);
    const items = this.all(`SELECT * FROM data_quality_errors ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, limit, (page - 1) * limit);
    return this.page(items, page, limit, total);
  }
}
