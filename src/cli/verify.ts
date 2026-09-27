import type { AddressInfo } from 'node:net';
import { createApp } from '../api/app.js';
import type { SqliteCatalogRepository } from '../db/sqlite.js';
import { isValidCurrency } from '../lib/currency.js';
import { isbn10To13, isValidIsbn10, isValidIsbn13 } from '../lib/isbn.js';
import { Taxonomy } from '../normalize/taxonomy.js';
import { main, withRepo } from './common.js';

interface Check {
  name: string;
  pass: boolean;
  detail: unknown;
  hard: boolean;
}

// npm run books:verify -- [--min-books 100]
// Verifies an imported catalog: dedupe, ISBNs, editions, categories, images, prices, popularity, search and API responses.
await main(async (rt, a) => {
  const repo = withRepo(rt) as SqliteCatalogRepository;
  const db = repo.db;
  const q = <T = Record<string, unknown>>(sql: string, ...p: Array<string | number>) => db.prepare(sql).all(...p) as T[];
  const one = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail: unknown, hard = true) => checks.push({ name, pass, detail, hard });
  const minBooks = a.num('min-books') ?? 100;

  const books = one('SELECT COUNT(*) n FROM books');
  const editions = one('SELECT COUNT(*) n FROM book_editions');
  check('catalog size', books >= minBooks, { books, editions, min_books: minBooks });

  // Deduplication.
  const dupTitle = q(`SELECT title_key, author_key, COUNT(*) n FROM books WHERE author_key <> '' GROUP BY title_key, author_key HAVING n > 1`);
  check('no duplicate works (same normalized title + authors)', dupTitle.length === 0, dupTitle.slice(0, 10), false);
  const dupOl = one('SELECT COUNT(*) n FROM (SELECT open_library_work_id FROM books WHERE open_library_work_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1)');
  check('Open Library work ids unique', dupOl === 0, dupOl);

  // ISBNs.
  const eds = q<{ isbn_10: string | null; isbn_13: string | null }>('SELECT isbn_10, isbn_13 FROM book_editions');
  const bad13 = eds.filter((e) => e.isbn_13 && !isValidIsbn13(e.isbn_13)).length;
  const bad10 = eds.filter((e) => e.isbn_10 && !isValidIsbn10(e.isbn_10)).length;
  const mismatch = eds.filter((e) => e.isbn_10 && e.isbn_13 && isbn10To13(e.isbn_10) !== e.isbn_13).length;
  check('ISBN checksums valid and ISBN-10/13 pairs consistent', bad13 + bad10 + mismatch === 0, { bad13, bad10, mismatch, with_isbn13: eds.filter((e) => e.isbn_13).length });

  // Editions.
  const multi = one('SELECT COUNT(*) n FROM (SELECT book_id FROM book_editions GROUP BY book_id HAVING COUNT(*) > 1)');
  const orphanPrimary = one('SELECT COUNT(*) n FROM books b WHERE b.primary_edition_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM book_editions e WHERE e.id = b.primary_edition_id AND e.book_id = b.id)');
  check('editions attached to works (work ≠ edition)', orphanPrimary === 0 && editions >= books, { works_with_multiple_editions: multi, avg_editions_per_work: +(editions / Math.max(books, 1)).toFixed(2), orphan_primary: orphanPrimary });

  // Categories.
  const taxonomy = new Taxonomy(rt.config.taxonomy);
  const cats = q<{ c: string | null; s: string | null; n: number }>(
    'SELECT c.name c, s.name s, COUNT(*) n FROM books b LEFT JOIN categories c ON c.id = b.category_id LEFT JOIN categories s ON s.id = b.subcategory_id GROUP BY 1, 2',
  );
  const invalidCats = cats.filter((r) => !taxonomy.isValid(r.c, r.s));
  const classified = cats.filter((r) => r.c).reduce((s, r) => s + r.n, 0);
  const topLevel = new Set(cats.filter((r) => r.c).map((r) => r.c));
  check('categories valid against taxonomy', invalidCats.length === 0, invalidCats);
  check('classification coverage ≥ 80%', classified / Math.max(books, 1) >= 0.8, { classified, books, top_level_categories: [...topLevel] }, false);

  // Images.
  const withImg = one(`SELECT COUNT(DISTINCT b.id) n FROM books b JOIN edition_images i ON i.edition_id = b.primary_edition_id AND i.kind = 'front' AND COALESCE(i.reachable, 1) = 1`);
  const backs = one(`SELECT COUNT(*) n FROM edition_images WHERE kind = 'back'`);
  const unreachable = one('SELECT COUNT(*) n FROM edition_images WHERE reachable = 0');
  check('front covers on primary editions', withImg / Math.max(books, 1) >= 0.7, { with_front_cover: withImg, books, unreachable_stored: unreachable }, false);
  check('no back covers without a source', backs === 0, { back_covers: backs, note: 'no enabled source provides back covers; any here needs review' }, false);

  // Prices.
  const prices = q<{ amount: number; currency: string; source: string }>('SELECT amount, currency, source FROM edition_prices');
  const badPrices = prices.filter((p) => p.amount < 0 || !isValidCurrency(p.currency)).length;
  check('prices non-negative with ISO-4217 currency', badPrices === 0, { price_rows: prices.length, bad: badPrices, sources: [...new Set(prices.map((p) => p.source))] });

  // Popularity.
  const pop = q<{ s: number | null }>('SELECT popularity_score s FROM books');
  const scored = pop.filter((p) => p.s !== null);
  check('popularity scores present and in [0,100]', scored.every((p) => p.s! >= 0 && p.s! <= 100) && scored.length > 0, {
    scored: scored.length,
    min: Math.min(...scored.map((p) => p.s!)),
    max: Math.max(...scored.map((p) => p.s!)),
  });

  // Search: exact title and ISBN of sample books rank first (ties on identical titles are allowed).
  const sample = q<{ id: string; title: string; isbn_13: string | null }>(
    'SELECT b.id, b.title, e.isbn_13 FROM books b LEFT JOIN book_editions e ON e.id = b.primary_edition_id ORDER BY b.popularity_score DESC LIMIT 25',
  );
  const titleMiss: string[] = [];
  const isbnMiss: string[] = [];
  for (const s of sample) {
    const r = repo.search(s.title, 1, 5);
    const top = r.items[0];
    if (!top || (top.id !== s.id && top.title.toLowerCase() !== s.title.toLowerCase())) titleMiss.push(s.title);
    if (s.isbn_13 && repo.search(s.isbn_13, 1, 1).items[0]?.id !== s.id) isbnMiss.push(s.isbn_13);
  }
  check('search ranks exact title first', titleMiss.length === 0, { sampled: sample.length, misses: titleMiss });
  check('search ranks ISBN match first', isbnMiss.length === 0, { misses: isbnMiss });

  // API responses.
  const app = createApp({ rt, repo });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const apiIssues: string[] = [];
  const get = async (p: string, expect = 200) => {
    const r = await fetch(base + p);
    if (r.status !== expect) apiIssues.push(`${p} → ${r.status}`);
    return r.json() as Promise<Record<string, unknown>>;
  };
  try {
    const list = await get('/api/books?limit=5');
    if ((list.items as unknown[]).length !== Math.min(5, books)) apiIssues.push('pagination size');
    await get('/api/books?limit=1000', 400);
    const first = sample[0];
    if (first) {
      const b = await get(`/api/books/${first.id}`);
      for (const k of ['title', 'authors', 'genre', 'popularity', 'price', 'images', 'tags', 'category', 'isbn_13', 'edition', 'identifiers', 'source', 'metadata']) if (!(k in b)) apiIssues.push(`missing ${k}`);
      await get(`/api/books/${first.id}/editions`);
      if (first.isbn_13) await get(`/api/books/isbn/${first.isbn_13}`);
      await get(`/api/books/search?q=${encodeURIComponent(first.title)}`);
    }
    await get('/api/books/popular?limit=10');
    const topCat = [...topLevel][0];
    if (topCat) await get(`/api/books/category/${encodeURIComponent(topCat)}`);
    await get('/api/books/genre/fiction');
    await get('/api/admin/stats');
  } finally {
    server.close();
  }
  check('API endpoints respond with expected shapes', apiIssues.length === 0, apiIssues);

  repo.close();
  const failed = checks.filter((c) => !c.pass && c.hard);
  if (failed.length) process.exitCode = 1;
  return { passed: checks.filter((c) => c.pass).length, failed_hard: failed.length, warnings: checks.filter((c) => !c.pass && !c.hard).length, checks };
});
