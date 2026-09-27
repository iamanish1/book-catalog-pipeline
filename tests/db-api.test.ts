import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { openRepository } from '../src/db/index.js';
import type { SqliteCatalogRepository } from '../src/db/sqlite.js';
import type { MergedWork } from '../src/domain/types.js';
import { dedupe } from '../src/matching/dedupe.js';
import { Taxonomy } from '../src/normalize/taxonomy.js';
import { buildContext, buildMergedWork } from '../src/normalize/work-builder.js';
import { createRuntime } from '../src/providers/registry.js';
import { flagProbableDuplicates, validateWork } from '../src/validation/validate.js';
import { config, edition, testEnv, work } from './helpers.js';

const ctx = buildContext(config);
const taxonomy = new Taxonomy(config.taxonomy);
const at = '2026-09-27T00:00:00.000Z';
const price = (amount: number, source = 'amazon', offer_format: 'Paperback' | 'eBook' | null = 'Paperback', retrieved_at = at) => ({ amount, currency: 'INR', source, offer_format, buy_url: null, retrieved_at, raw: null });

function mergedPsych(extra: Omit<Partial<Parameters<typeof edition>[0]>, 'title'> = {}): MergedWork {
  const w = work({ olWorkId: 'OL1W', title: 'The Psychology of Money', authors: ['Morgan Housel'], first_publication_year: 2020, subjects_raw: ['Personal finance', 'Finance, Personal'], signals: { average_rating: 4, ratings_count: 400, edition_count: 27, readinglog_count: 3000, bestseller_mentions: 0, retailer_available: null } });
  const e = edition({ source: 'open_library', title: 'The Psychology of Money', authors: ['Morgan Housel'], isbn_13: '9780857197689', isbn_10: '0857197681', publisher: 'Harriman House', format: 'Paperback', identifiers: { open_library_work_id: 'OL1W', open_library_edition_id: 'OL10M' }, images: [{ kind: 'front', url: 'https://covers.openlibrary.org/b/id/1-L.jpg', source: 'open_library', license: null, retrieved_at: at }], ...extra });
  const hp = edition({ source: 'open_library', title: 'The Psychology of Money', authors: ['Morgan Housel'], isbn_13: '9781804090114', format: 'Hardcover', identifiers: { open_library_work_id: 'OL1W', open_library_edition_id: 'OL12M' } });
  return buildMergedWork(dedupe([w, e, hp]).groups[0]!, ctx);
}

function mergedSimple(title: string, author: string, isbn: string, subjects: string[], ratings = 10): MergedWork {
  const e = edition({ title, authors: [author], isbn_13: isbn, categories_raw: subjects, identifiers: { google_books_id: `gb-${isbn}` }, signals: { average_rating: 4, ratings_count: ratings, edition_count: null, readinglog_count: null, bestseller_mentions: null, retailer_available: null } });
  return buildMergedWork(dedupe([e]).groups[0]!, ctx);
}

describe('validation', () => {
  it('repairs bad non-critical fields and quarantines critical failures', () => {
    const w = mergedPsych();
    w.first_publication_year = 3020;
    w.editions[0]!.isbn_13 = '9780857197680'; // bad checksum
    w.editions[0]!.offers.push(price(-5), { ...price(10), currency: 'RUPEES' });
    w.editions[0]!.images[0]!.reachable = false;
    const r = validateWork(w, taxonomy);
    expect(r.valid).toBe(true);
    expect(r.work.first_publication_year).toBeNull();
    expect(r.work.editions[0]!.isbn_13).toBeNull();
    expect(r.work.editions[0]!.offers).toEqual([]);
    expect(r.work.editions[0]!.images).toEqual([]);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['unreasonable_year', 'invalid_isbn13', 'invalid_price', 'invalid_currency', 'unreachable_image']));

    const bad = mergedPsych();
    bad.title = ' ';
    bad.category = 'Cookery Nonsense';
    const r2 = validateWork(bad, taxonomy);
    expect(r2.valid).toBe(false);
    expect(r2.issues.filter((i) => i.severity === 'error').map((i) => i.code).sort()).toEqual(['invalid_category', 'missing_title']);
  });

  it('quarantines the weaker of two probable duplicates', () => {
    const a = validateWork(mergedSimple('Atomic Habits', 'James Clear', '9780735211292', ['Self-Help'], 500), taxonomy);
    const b = validateWork(mergedSimple('Atomic Habits', 'James Clear', '9781847941831', ['Self-Help'], 5), taxonomy);
    a.work.duplicate_candidates = [{ other_key: b.work.key, other_title: 'Atomic Habits', similarity: 0.95, reason: 'test' }];
    flagProbableDuplicates([a, b], 0.9);
    expect(a.valid).toBe(true);
    expect(b.valid).toBe(false);
    expect(b.issues.at(-1)!.code).toBe('probable_duplicate');
  });
});

describe('SQLite repository', () => {
  const env = testEnv();
  const rt = createRuntime({ env, config });
  let repo: SqliteCatalogRepository;
  beforeAll(() => {
    repo = openRepository(env, config, rt.providers) as SqliteCatalogRepository;
  });

  it('upserts idempotently and dedupes against the database by ISBN', () => {
    const first = repo.upsertWork(mergedPsych(), null);
    expect(first.action).toBe('inserted');
    expect(first.editions_inserted).toBe(2);
    const again = repo.upsertWork(mergedPsych(), null);
    expect(again).toMatchObject({ action: 'updated', book_id: first.book_id, matched_by: 'isbn_13', editions_inserted: 0 });
    // A Google Books-only record for the same ISBN (no OL work id) resolves to the same book.
    const gbOnly = mergedSimple('Psychology of Money', 'Morgan Housel', '9780857197689', ['Business & Economics / Personal Finance']);
    expect(repo.upsertWork(gbOnly, null).book_id).toBe(first.book_id);
    const n = repo.db.prepare('SELECT COUNT(*) n FROM books').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('keeps higher-precedence values and records the conflict', () => {
    const w = mergedPsych();
    const id = repo.getBookByIsbn('9780857197689')!.id;
    w.title = 'THE PSYCHOLOGY OF MONEY (special)';
    w.field_sources.title = 'amazon'; // lowest precedence for titles
    const r = repo.upsertWork(w, null);
    expect(r.book_id).toBe(id);
    expect(repo.getBook(id)!.title).toBe('The Psychology of Money');
    expect(r.conflicts.some((c) => c.startsWith('title: kept open_library'))).toBe(true);
  });

  it('keeps price history per edition and marks only the latest as current', () => {
    const later = '2026-09-28T00:00:00.000Z';
    repo.upsertWork(mergedPsych({ price: price(499, 'amazon', 'Paperback', at) }), null);
    repo.upsertWork(mergedPsych({ price: price(449, 'amazon', 'Paperback', later) }), null);
    const rows = repo.db.prepare("SELECT amount, is_current FROM edition_prices ORDER BY retrieved_at").all() as Array<{ amount: number; is_current: number }>;
    expect(rows).toEqual([
      { amount: 499, is_current: 0 },
      { amount: 449, is_current: 1 },
    ]);
    const book = repo.getBookByIsbn('0857197681')!;
    expect(book.price).toEqual({ amount: 449, currency: 'INR' });
    expect(book.price_metadata).toMatchObject({ source: 'amazon', retrieved_at: later, offer_format: 'Paperback' });
    expect(book.isbn_13).toBe('9780857197689');
    expect(book.edition?.format).toBe('Paperback');
    expect(book.images.front).toBe('https://covers.openlibrary.org/b/id/1-L.jpg');
    expect(book.images.back).toBeNull();
  });

  it('searches with exact-title, ISBN and author boosts', () => {
    repo.upsertWork(mergedSimple('Money: A Love Story', 'Kate Northrup', '9781401945367', ['Self-Help'], 5000), null);
    repo.upsertWork(mergedSimple('The Money Book', 'Some Author', '9780306406157', ['Business & Economics'], 90000), null);
    const byTitle = repo.search('the psychology of money', 1, 10);
    expect(byTitle.items[0]!.title).toBe('The Psychology of Money');
    const byIsbn = repo.search('978-1401945367', 1, 10);
    expect(byIsbn.items[0]!.title).toBe('Money: A Love Story');
    const byAuthor = repo.search('Morgan Housel', 1, 10);
    expect(byAuthor.items[0]!.authors).toContain('Morgan Housel');
    const partial = repo.search('psychol', 1, 10);
    expect(partial.total).toBeGreaterThan(0);
    expect(repo.search('zzzz nothing', 1, 10).total).toBe(0);
  });

  describe('REST API', () => {
    let base = '';
    let close = () => {};
    beforeAll(async () => {
      const app = createApp({ rt, repo });
      await new Promise<void>((resolve) => {
        const server = app.listen(0, () => {
          base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          close = () => server.close();
          resolve();
        });
      });
    });
    afterAll(() => close());
    const get = async (p: string) => {
      const r = await fetch(base + p);
      return { status: r.status, body: (await r.json()) as Record<string, unknown> & { items?: Array<Record<string, unknown>> } };
    };

    it('lists books with pagination and caps page size', async () => {
      const r = await get('/api/books?limit=2&page=1');
      expect(r.status).toBe(200);
      expect(r.body.items).toHaveLength(2);
      expect(r.body).toMatchObject({ page: 1, limit: 2, total: 3, total_pages: 2 });
      expect((await get('/api/books?limit=5000')).status).toBe(400);
    });

    it('returns the product schema for a book and its editions', async () => {
      const b = (await get('/api/books/isbn/9780857197689')).body;
      for (const k of ['title', 'authors', 'publication_year', 'genre', 'popularity', 'price', 'short_description', 'images', 'tags', 'category', 'subcategory', 'isbn_10', 'isbn_13', 'publisher', 'language', 'page_count', 'edition', 'identifiers', 'source', 'source_urls', 'metadata']) {
        expect(b).toHaveProperty(k);
      }
      expect(b.popularity).toMatchObject({ popularity_source: 'internal_normalized_score' });
      const one = await get(`/api/books/${String(b.id)}`);
      expect(one.body.title).toBe('The Psychology of Money');
      const eds = await get(`/api/books/${String(b.id)}/editions`);
      expect(eds.body.total).toBe(2);
      expect(eds.body.items!.filter((e) => e.is_primary)).toHaveLength(1);
      expect((await get('/api/books/does-not-exist')).status).toBe(404);
      expect((await get('/api/books/isbn/123')).status).toBe(400);
    });

    it('supports search, category, genre and popular endpoints', async () => {
      const s = await get('/api/books/search?q=psychology+of+money');
      expect(s.body.items![0]!.title).toBe('The Psychology of Money');
      expect((await get('/api/books/search')).status).toBe(400);
      const cat = await get('/api/books/category/business-and-economics');
      expect(cat.status).toBe(200);
      expect(cat.body.items!.every((b) => b.category === 'Business & Economics')).toBe(true);
      const sub = await get('/api/books/category/finance');
      expect(sub.body).toMatchObject({ category: 'Business & Economics', subcategory: 'Finance' });
      expect((await get('/api/books/category/not-a-category')).status).toBe(404);
      const g = await get('/api/books/genre/finance');
      expect(g.status).toBe(200);
      expect(g.body.items!.length).toBeGreaterThan(0);
      const pop = await get('/api/books/popular?limit=3');
      const scores = pop.body.items!.map((b) => (b.popularity as { score: number }).score);
      expect([...scores].sort((a, c) => c - a)).toEqual(scores);
    });

    it('exposes admin stats', async () => {
      const s = await get('/api/admin/stats');
      expect(s.status).toBe(200);
      expect(s.body).toMatchObject({ books: 3 });
      expect(s.body).toHaveProperty('books_missing_prices');
      expect(s.body).toHaveProperty('source_distribution');
    });
  });

  it('requires the admin token when configured', async () => {
    const secured = createApp({ rt: { ...rt, env: { ...env, adminApiToken: 'sekret' } }, repo });
    const server = secured.listen(0);
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/stats`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: 'Bearer sekret' } })).status).toBe(200);
    server.close();
  });
});

describe('transactions', () => {
  it('rolls back only the failing nested unit of work', () => {
    const env = testEnv();
    const repo = openRepository(env, config, []) as SqliteCatalogRepository;
    const count = () => (repo.db.prepare('SELECT COUNT(*) n FROM tags').get() as { n: number }).n;
    repo.transaction(() => {
      repo.db.prepare("INSERT INTO tags(name) VALUES ('kept')").run();
      expect(() =>
        repo.transaction(() => {
          repo.db.prepare("INSERT INTO tags(name) VALUES ('discarded')").run();
          throw new Error('boom');
        }),
      ).toThrow('boom');
    });
    expect(count()).toBe(1);
    repo.close();
  });
});
