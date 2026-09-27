import { describe, expect, it } from 'vitest';
import { clusterEditions, dedupe } from '../src/matching/dedupe.js';
import { buildContext, buildMergedWork } from '../src/normalize/work-builder.js';
import { config, edition, work } from './helpers.js';

const ctx = buildContext(config);
const housel = ['Morgan Housel'];
const img = (url: string, source: string) => ({ kind: 'front' as const, url, source, license: null, retrieved_at: '2026-09-27T00:00:00.000Z' });

function psychMoneyFixture() {
  const w = work({
    olWorkId: 'OL1W',
    title: 'The Psychology of Money',
    authors: housel,
    first_publication_year: 2020,
    description: 'Open Library description of the work, long enough to count.',
    subjects_raw: ['Personal finance', 'Finance, Personal', 'Psychology'],
    known_isbn13s: ['9780857197689', '9781804090114'],
    signals: { average_rating: 4, ratings_count: 400, edition_count: 27, readinglog_count: 3000, bestseller_mentions: 1, retailer_available: null },
  });
  const olA = edition({ source: 'open_library', source_id: 'OL10M', title: 'The Psychology of Money', authors: housel, isbn_13: '9780857197689', isbn_10: '0857197681', publisher: 'Harriman House', format: 'Paperback', publication_year: 2020, identifiers: { open_library_work_id: 'OL1W', open_library_edition_id: 'OL10M' }, images: [img('https://covers.openlibrary.org/b/id/1-L.jpg', 'open_library')] });
  const olA2 = edition({ source: 'open_library', source_id: 'OL11M', title: 'The Psychology of Money', authors: housel, isbn_13: '9780857197689', publisher: 'Harriman House', identifiers: { open_library_work_id: 'OL1W', open_library_edition_id: 'OL11M' } });
  const olB = edition({ source: 'open_library', source_id: 'OL12M', title: 'The Psychology of Money', authors: housel, isbn_13: '9781804090114', publisher: 'Harriman House', format: 'Hardcover', identifiers: { open_library_work_id: 'OL1W', open_library_edition_id: 'OL12M' } });
  const gbA = edition({
    source: 'google_books',
    source_id: 'gb1',
    title: 'The Psychology of Money',
    subtitle: 'Timeless lessons on wealth, greed, and happiness',
    authors: housel,
    isbn_13: '9780857197689',
    publisher: 'Harriman House Limited',
    description: 'Google Books description which should win by source precedence.',
    categories_raw: ['Business & Economics / Personal Finance / General'],
    identifiers: { google_books_id: 'gb1' },
    price: { amount: 299, currency: 'INR', source: 'google_books', offer_format: 'eBook', buy_url: null, retrieved_at: '2026-09-27T00:00:00.000Z', raw: null },
    signals: { average_rating: 4.5, ratings_count: 100, edition_count: null, readinglog_count: null, bestseller_mentions: null, retailer_available: true },
  });
  // Subtitle variant with an ISBN Open Library doesn't list: joins by exact title key + author.
  const gbIndian = edition({ source: 'google_books', source_id: 'gb2', title: 'The Psychology of Money: Timeless lessons on wealth, greed and happiness', authors: ['Housel, Morgan'], isbn_13: '9789390166268', publisher: 'Jaico', identifiers: { google_books_id: 'gb2' } });
  return { w, olA, olA2, olB, gbA, gbIndian };
}

describe('deduplication and edition matching', () => {
  it('merges the same book from Open Library and Google Books into one work with distinct editions', () => {
    const f = psychMoneyFixture();
    const { groups, stats } = dedupe([f.w, f.olA, f.olA2, f.olB, f.gbA, f.gbIndian]);
    expect(groups).toHaveLength(1);
    expect(stats.edition_duplicates_merged).toBe(2); // olA2 and gbA collapse into olA's edition
    const merged = buildMergedWork(groups[0]!, ctx);
    const isbns = merged.editions.map((e) => e.isbn_13).sort();
    expect(isbns).toEqual(['9780857197689', '9781804090114', '9789390166268']);

    const a = merged.editions.find((e) => e.isbn_13 === '9780857197689')!;
    expect(a.sources.sort()).toEqual(['google_books', 'open_library']);
    expect(a.identifiers).toMatchObject({ google_books_id: 'gb1', open_library_edition_id: 'OL10M' });
    // Publisher: Open Library outranks Google Books; the differing value is kept as a conflict, not overwritten silently.
    expect(a.publisher).toBe('Harriman House');
    expect(a.field_sources.publisher).toBe('open_library');
    expect(a.conflicts.find((c) => c.field === 'publisher')?.alternatives[0]).toEqual({ source: 'google_books', value: 'Harriman House Limited' });
    // Price is edition-level and keeps its provenance and offer format.
    expect(a.offers[0]).toMatchObject({ amount: 299, currency: 'INR', source: 'google_books', offer_format: 'eBook' });
    expect(merged.editions.find((e) => e.isbn_13 === '9781804090114')!.offers).toEqual([]);

    // Work-level precedence.
    expect(merged.title).toBe('The Psychology of Money');
    expect(merged.field_sources.title).toBe('open_library');
    expect(merged.description).toMatch(/^Google Books description/);
    expect(merged.field_sources.description).toBe('google_books');
    expect(merged.identifiers.open_library_work_id).toBe('OL1W');
    expect(merged.category).toBe('Business & Economics');
    expect(merged.subcategory).toBe('Finance');
    expect(merged.popularity.ratings_count).toBe(500);
    expect(merged.popularity.score).toBeGreaterThan(0);
    expect(merged.sources.sort()).toEqual(['google_books', 'open_library']);
  });

  it('does not merge a same-title book by a different author', () => {
    const f = psychMoneyFixture();
    const other = edition({ title: 'The Psychology of Money', authors: ['John Smith'], isbn_13: '9780306406157', identifiers: { google_books_id: 'gb9' } });
    const { groups } = dedupe([f.w, f.olA, other]);
    expect(groups).toHaveLength(2);
  });

  it('never merges records with different ISBN-13s even if a weaker id collides', () => {
    const e1 = edition({ title: 'X', isbn_13: '9780857197689', identifiers: { google_books_id: 'same' } });
    const e2 = edition({ title: 'X', isbn_13: '9781804090114', identifiers: { google_books_id: 'same' } });
    const { clusters, conflicts } = clusterEditions([e1, e2]);
    expect(clusters).toHaveLength(2);
    expect(conflicts[0]).toMatch(/^identity_conflict:gb:same/);
  });

  it('merges ISBN-10-only and ISBN-13 records of the same edition', () => {
    const a = edition({ title: 'X', isbn_13: '9780857197689', isbn_10: '0857197681' });
    const b = edition({ title: 'X', isbn_10: '0857197681', source: 'amazon', identifiers: { asin: '0857197681' } });
    expect(clusterEditions([a, b]).clusters).toHaveLength(1);
  });

  it('merges duplicate Open Library works that share an edition ISBN, but only flags same-title works without shared evidence', () => {
    const w1 = work({ olWorkId: 'OL1W', title: 'Atomic Habits', authors: ['James Clear'] });
    const w2 = work({ olWorkId: 'OL2W', title: 'Atomic habits', authors: ['James Clear'] });
    const e1 = edition({ source: 'open_library', title: 'Atomic Habits', isbn_13: '9780735211292', identifiers: { open_library_work_id: 'OL1W', open_library_edition_id: 'OL1M' } });
    const e2 = edition({ source: 'open_library', title: 'Atomic Habits', isbn_13: '9780735211292', identifiers: { open_library_work_id: 'OL2W', open_library_edition_id: 'OL2M' } });
    expect(dedupe([w1, w2, e1, e2]).groups).toHaveLength(1);

    const w3 = work({ olWorkId: 'OL3W', title: 'Atomic Habits', authors: ['James Clear'] });
    const w4 = work({ olWorkId: 'OL4W', title: 'Atomic Habits', authors: ['James Clear'] });
    const r = dedupe([w3, w4]);
    expect(r.groups).toHaveLength(2);
    expect(r.groups[0]!.duplicateCandidates[0]).toMatchObject({ similarity: 0.95 });
  });

  it('uses fuzzy similarity only to generate candidates', () => {
    const a = edition({ title: 'The Psychology of Money', authors: housel, isbn_13: '9780857197689' });
    const b = edition({ title: 'The Psychology of Moneys', authors: housel, isbn_13: '9781804090114' });
    const { groups } = dedupe([a, b]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.duplicateCandidates.length).toBe(1);
    expect(groups[0]!.duplicateCandidates[0]!.similarity).toBeLessThan(0.9);
  });

  it('orders editions so the most commercially complete one is presented first', () => {
    const f = psychMoneyFixture();
    const merged = buildMergedWork(dedupe([f.w, f.olA, f.olB, f.gbA]).groups[0]!, ctx);
    expect(merged.editions[0]!.isbn_13).toBe('9780857197689'); // has price + cover
    expect(merged.editions[0]!.images[0]!.source).toBe('open_library');
  });
});

describe('import selection', () => {
  it('keeps every discovery query represented when capping catalog size', async () => {
    const { stratifiedSelection } = await import('../src/pipeline/import.js');
    const mk = (q: string, i: number, score: number) => {
      const m = buildMergedWork(dedupe([edition({ title: `${q} book ${i}`, authors: [`Author ${q}${i}`], isbn_13: null, identifiers: { google_books_id: `${q}-${i}` } })]).groups[0]!, ctx);
      m.discovery = [{ query_id: q, source: 'open_library', rank: i + 1, total: 10, category_hint: null, subcategory_hint: null, genre_hint: null }];
      m.popularity = { ...m.popularity, score };
      return m;
    };
    const works = [...[0, 1, 2, 3, 4].map((i) => mk('popular', i, 90 - i)), mk('niche', 0, 5), mk('regional', 0, 1)];
    const picked = stratifiedSelection(works, 4).map((w) => w.discovery[0]!.query_id);
    expect(picked.sort()).toEqual(['niche', 'popular', 'popular', 'regional']);
  });
});
