import { describe, expect, it } from 'vitest';
import type { EditionSourceRecord, WorkSourceRecord } from '../src/domain/types.js';
import { AmazonProvider, signPaapiRequest } from '../src/providers/amazon.js';
import { GoogleBooksProvider } from '../src/providers/google-books.js';
import { OpenLibraryProvider } from '../src/providers/open-library.js';
import type { FetchedItem } from '../src/providers/types.js';
import { parseRobots, policyFromRules } from '../src/scrapers/robots.js';
import { extractSchemaOrgBooks } from '../src/scrapers/publisher/schema-org.js';
import { fakeHttp, fixture, putRaw, testEnv, tmpStore } from './helpers.js';

const item = (p: Partial<FetchedItem>): FetchedItem => ({
  source: 'open_library',
  item_key: 'x',
  role: 'discovery',
  query_id: 'q1',
  rank: 1,
  total: 100,
  raw_refs: [],
  locator: {},
  hints: { category: 'Business & Economics', subcategory: 'Finance', genre: 'Finance', language: null },
  fetched_at: '2026-09-27T00:00:00.000Z',
  ...p,
});

describe('OpenLibraryProvider normalization (real fixtures)', () => {
  const store = tmpStore();
  const ol = new OpenLibraryProvider(fakeHttp(store), testEnv());
  const searchRef = putRaw(store, 'open_library', 'search', 's', {
    numFound: 1,
    docs: [{ key: '/works/OL21640039W', title: 'The Psychology of Money', author_name: ['Morgan Housel'], first_publish_year: 2020, edition_count: 27, ratings_average: 3.99, ratings_count: 422, readinglog_count: 3000, isbn: ['9780857197689', '0857197681'], subject: ['Personal finance', 'New York Times bestseller'] }],
  });
  const workRef = putRaw(store, 'open_library', 'work', 'w', fixture('ol-work-psych-money.json'));
  const edRef = putRaw(store, 'open_library', 'editions', 'e', fixture('ol-editions-psych-money.json'));
  const out = ol.normalizeItem(item({ item_key: 'OL21640039W', raw_refs: [searchRef, workRef, edRef], locator: { doc_index: 0 } }), store);
  const w = out.records.find((r): r is WorkSourceRecord => r.record_type === 'work')!;
  const eds = out.records.filter((r): r is EditionSourceRecord => r.record_type === 'edition');

  it('emits a work record with ids, signals and bestseller markers', () => {
    expect(w.identifiers.open_library_work_id).toBe('OL21640039W');
    expect(w.authors).toEqual(['Morgan Housel']);
    expect(w.first_publication_year).toBe(2020);
    expect(w.signals).toMatchObject({ ratings_count: 422, edition_count: 27, readinglog_count: 3000, bestseller_mentions: 1 });
    expect(w.description).toMatch(/^Timeless lessons/);
    expect(w.known_isbn13s).toContain('9780857197689');
    expect(w.discovery[0]).toMatchObject({ query_id: 'q1', rank: 1, category_hint: 'Business & Economics' });
  });

  it('keeps ISBN editions with edition-level facts and rejects derivative/mislinked titles', () => {
    expect(eds.length).toBeGreaterThan(0);
    for (const e of eds) {
      expect(e.isbn_13).toMatch(/^97[89]\d{10}$/);
      expect(e.identifiers.open_library_work_id).toBe('OL21640039W');
      expect(e.identifiers.open_library_edition_id).toMatch(/^OL\d+M$/);
    }
    const pb = eds.find((e) => e.isbn_13 === '9781804090114')!;
    expect(pb).toMatchObject({ format: 'Paperback', publisher: 'Harriman House', page_count: 242, language: 'en', publication_year: 2020 });
    expect(pb.images[0]!.url).toBe('https://covers.openlibrary.org/b/id/15215448-L.jpg?default=false');
    expect(out.rejected.map((r) => r.reason)).toContain('derivative_title'); // "Concise Psychology of Money"
    expect(eds.some((e) => /concise/i.test(e.title))).toBe(false);
    // Junk publisher values are dropped rather than stored.
    expect(eds.every((e) => e.publisher !== 'no idea')).toBe(true);
  });
});

describe('GoogleBooksProvider normalization', () => {
  const store = tmpStore();
  const gb = new GoogleBooksProvider(fakeHttp(store), { googleBooksApiKey: 'k', googleBooksCountry: 'IN' });
  const ref = putRaw(store, 'google_books', 'search', 'q', fixture('gb-volumes-psych-money.json'));
  const [rec] = gb.normalizeItem(item({ source: 'google_books', item_key: 'gbFixture001', raw_refs: [ref], locator: { item_index: 0 } }), store).records as EditionSourceRecord[];

  it('maps volumeInfo + saleInfo into an edition record', () => {
    expect(rec).toMatchObject({
      title: 'The Psychology of Money',
      subtitle: 'Timeless lessons on wealth, greed, and happiness',
      isbn_13: '9780857197689',
      isbn_10: '0857197681',
      publisher: 'Harriman House Limited',
      publication_year: 2020,
      language: 'en',
      page_count: 256,
      format: null,
    });
    expect(rec!.identifiers.google_books_id).toBe('gbFixture001');
    expect(rec!.description).toBe('Doing well with money isn’t necessarily about what you know. It’s about how you behave.\nIn The Psychology of Money, the author shares 19 short stories exploring the strange ways people think about money.');
    expect(rec!.signals).toMatchObject({ average_rating: 4.5, ratings_count: 120, retailer_available: true });
  });

  it('records the Google Play price as an eBook offer in INR, with https cover and no curl effect', () => {
    expect(rec!.price).toMatchObject({ amount: 299, currency: 'INR', source: 'google_books', offer_format: 'eBook' });
    expect(rec!.images[0]!.url.startsWith('https://')).toBe(true);
    expect(rec!.images[0]!.url).not.toContain('edge=curl');
  });

  it('is disabled without an API key', () => {
    expect(new GoogleBooksProvider(fakeHttp(store), { googleBooksApiKey: '', googleBooksCountry: 'IN' }).isEnabled()).toBe(false);
  });
});

describe('AmazonProvider (PA-API 5)', () => {
  it('signs requests with AWS SigV4', () => {
    const h = signPaapiRequest({
      accessKey: 'AKIDEXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'eu-west-1',
      host: 'webservices.amazon.in',
      path: '/paapi5/searchitems',
      target: 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems',
      body: '{"Keywords":"9780857197689"}',
      now: new Date('2026-09-27T10:00:00Z'),
    });
    expect(h['x-amz-date']).toBe('20260927T100000Z');
    expect(h.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260927\/eu-west-1\/ProductAdvertisingAPI\/aws4_request, SignedHeaders=content-encoding;content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
  });

  it('normalizes an item with a retailer price for the paperback edition', () => {
    const store = tmpStore();
    const ref = putRaw(store, 'amazon', 'searchitems', 'i', fixture('paapi-searchitems.json'));
    const az = new AmazonProvider(fakeHttp(store), testEnv());
    expect(az.isEnabled()).toBe(false);
    const [rec] = az.normalizeItem(item({ source: 'amazon', item_key: '0857197681', raw_refs: [ref], locator: { item_index: 0 }, role: 'enrichment', rank: null }), store).records as EditionSourceRecord[];
    expect(rec).toMatchObject({ isbn_13: '9780857197689', format: 'Paperback', publisher: 'Jaico Publishing House', page_count: 252, language: 'en' });
    expect(rec!.price).toMatchObject({ amount: 249, currency: 'INR', offer_format: 'Paperback', source: 'amazon' });
    expect(rec!.categories_raw).toContain('Personal Finance');
  });
});

describe('scraper safeguards', () => {
  it('parses robots.txt groups, wildcards and crawl-delay', () => {
    const txt = `User-agent: *\nDisallow: /search\nAllow: /search/about\nDisallow: /*.pdf$\nCrawl-delay: 5\n\nUser-agent: BadBot\nDisallow: /`;
    const p = policyFromRules(parseRobots(txt, 'BookCatalogPipeline/0.1'));
    expect(p.isAllowed('/books/123')).toBe(true);
    expect(p.isAllowed('/search?q=x')).toBe(false);
    expect(p.isAllowed('/search/about')).toBe(true);
    expect(p.isAllowed('/files/a.pdf')).toBe(false);
    expect(p.crawlDelayMs).toBe(5000);
    expect(policyFromRules(parseRobots(txt, 'BadBot/1.0')).isAllowed('/books')).toBe(false);
  });

  it('extracts schema.org Book JSON-LD', () => {
    const html = `<html><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Book","name":"The Psychology of Money","author":[{"@type":"Person","name":"Morgan Housel"}],"isbn":"9780857197689","bookFormat":"https://schema.org/Paperback","numberOfPages":256,"publisher":{"@type":"Organization","name":"Harriman House"},"offers":{"@type":"Offer","price":"399.00","priceCurrency":"INR"}}]}</script></html>`;
    const [b] = extractSchemaOrgBooks(html);
    expect(b).toMatchObject({ name: 'The Psychology of Money', authors: ['Morgan Housel'], isbns: ['9780857197689'], bookFormat: 'Paperback', numberOfPages: 256, publisher: 'Harriman House' });
    expect(b!.offer).toEqual({ price: '399.00', priceCurrency: 'INR', url: null });
  });
});
