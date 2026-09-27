import { describe, expect, it } from 'vitest';
import { GenreNormalizer } from '../src/normalize/genre.js';
import { TagGenerator } from '../src/normalize/tags.js';
import { Taxonomy } from '../src/normalize/taxonomy.js';
import { computePopularity, emptySignals } from '../src/scoring/popularity.js';
import { config } from './helpers.js';

const genres = new GenreNormalizer(config.taxonomy);
const taxonomy = new Taxonomy(config.taxonomy);
const tags = new TagGenerator(config.tags);

describe('genre normalization', () => {
  it('maps raw source variants to a controlled genre', () => {
    for (const raw of ['Fiction', 'Fiction / General', 'Novels']) expect(genres.mapRaw(raw).normalized).toContain('Fiction');
    expect(genres.mapRaw('Fiction / Fantasy / Epic').normalized).toEqual(expect.arrayContaining(['Fantasy', 'Fiction']));
    expect(genres.mapRaw('Business & Economics / Personal Finance / General').normalized).toEqual(expect.arrayContaining(['Business', 'Finance']));
    expect(genres.mapRaw('Non-fiction').normalized).not.toContain('Fiction');
    expect(genres.mapRaw('Science fiction').normalized).not.toContain('Science');
  });

  it('does not trust a single weak or single-source term', () => {
    // One Open Library subject (weight 0.6) is below the acceptance threshold.
    expect(genres.classify([{ raw: 'Horror', source: 'open_library' }]).genres).toEqual([]);
    // A discovery hint alone never assigns a genre.
    expect(genres.classify([{ raw: 'Horror', source: 'discovery_hint' }]).genres).toEqual([]);
    // Two independent signals do.
    expect(
      genres.classify([
        { raw: 'Horror', source: 'open_library' },
        { raw: 'Horror', source: 'discovery_hint' },
      ]).genres,
    ).toContain('Horror');
    // A curated category from Google Books is enough on its own.
    expect(genres.classify([{ raw: 'Fiction / Horror', source: 'google_books' }]).genres).toContain('Horror');
  });

  it('assigns multiple genres and treats non-fiction subjects on novels as topics', () => {
    const r = genres.classify([
      { raw: 'Science fiction', source: 'open_library' },
      { raw: 'Fiction, science fiction, general', source: 'open_library' },
      { raw: 'Artificial intelligence', source: 'open_library' },
      { raw: 'Computers', source: 'open_library' },
      { raw: 'Artificial Intelligence', source: 'discovery_hint' },
    ]);
    expect(r.genres).toContain('Science Fiction');
    expect(r.genres).not.toContain('Artificial Intelligence');
    expect(r.genres).not.toContain('Technology');
  });
});

describe('regional classification', () => {
  it('classifies Indian-language fiction from a subject plus the discovery hint', () => {
    const r = genres.classify([
      { raw: 'Tamil fiction', source: 'open_library' },
      { raw: 'Indian Literature', source: 'discovery_hint' },
    ]);
    expect(r.genres).toContain('Indian Literature');
    expect(taxonomy.classify(r.scores, r.genres)).toEqual({ category: 'Indian Interest', subcategory: 'Indian Literature' });
  });

  it('counts a discovery hint that names a genre exactly', () => {
    const r = genres.classify([
      { raw: 'Examinations, study guides', source: 'open_library' },
      { raw: 'Competitive Exams', source: 'discovery_hint' },
    ]);
    expect(r.genres).toContain('Competitive Exams');
  });
});

describe('taxonomy', () => {
  it('classifies into a controlled category/subcategory', () => {
    const r = genres.classify([{ raw: 'Computers / Artificial Intelligence / General', source: 'google_books' }]);
    expect(taxonomy.classify(r.scores, r.genres)).toEqual({ category: 'Technology', subcategory: 'Artificial Intelligence' });
    const f = genres.classify([{ raw: 'Fiction / Fantasy / Epic', source: 'google_books' }]);
    expect(taxonomy.classify(f.scores, f.genres)).toEqual({ category: 'Fiction', subcategory: 'Fantasy' });
  });

  it('falls back to a top-level category or null, never an invented one', () => {
    expect(taxonomy.classify({ Fiction: 1 }, ['Fiction'])).toEqual({ category: 'Fiction', subcategory: null });
    expect(taxonomy.classify({}, [])).toEqual({ category: null, subcategory: null });
    expect(taxonomy.isValid('Fiction', 'Fantasy')).toBe(true);
    expect(taxonomy.isValid('Fiction', 'Machine Learning')).toBe(false);
    expect(taxonomy.resolveCategory('business-and-economics')).toBe('Business & Economics');
  });
});

describe('tags', () => {
  it('produces lowercase, deduplicated, meaningful tags', () => {
    const t = tags.generate({
      genres: ['Fantasy', 'Young Adult', 'Fiction'],
      subcategory: 'Fantasy',
      subjects: ['Magic -- Fiction', 'Wizards', 'Accessible book', 'Protected DAISY', 'nyt:hardcover-fiction=2008-10-04', 'Fiction, fantasy, general', 'series:Harry_Potter', 'Finance, Personal', 'book', 'Magia', 'Wizards'],
      language: 'en',
    });
    expect(t).toEqual(expect.arrayContaining(['fantasy', 'young adult', 'magic', 'wizards', 'harry potter', 'personal finance']));
    for (const bad of ['fiction', 'accessible book', 'protected daisy', 'book']) expect(t).not.toContain(bad);
    expect(t.every((x) => x === x.toLowerCase())).toBe(true);
    expect(new Set(t).size).toBe(t.length);
    expect(t.some((x) => x.includes('nyt'))).toBe(false);
  });
});

describe('popularity', () => {
  const cfg = config.popularity;
  it('is null when no signal exists (never fabricated)', () => {
    expect(computePopularity({ open_library: emptySignals() }, [], cfg).score).toBeNull();
  });

  it('rewards volume of ratings over a tiny perfect average', () => {
    const many = computePopularity({ open_library: { ...emptySignals(), ratings_count: 50_000, average_rating: 4.3 } }, [], cfg);
    const few = computePopularity({ open_library: { ...emptySignals(), ratings_count: 2, average_rating: 5 } }, [], cfg);
    expect(many.score!).toBeGreaterThan(few.score!);
    expect(many.popularity_source).toBe('internal_normalized_score');
    expect(many.raw_signals.open_library!.ratings_count).toBe(50_000);
    expect(many.score!).toBeLessThanOrEqual(100);
  });

  it('combines ratings across platforms with a count-weighted mean', () => {
    const r = computePopularity(
      {
        open_library: { ...emptySignals(), ratings_count: 100, average_rating: 4 },
        google_books: { ...emptySignals(), ratings_count: 300, average_rating: 5 },
      },
      [],
      cfg,
    );
    expect(r.ratings_count).toBe(400);
    expect(r.rating).toBe(4.75);
  });
});
