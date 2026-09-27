import type { PublisherSiteConfig } from '../config/index.js';
import type { EditionSourceRecord, ImageRef } from '../domain/types.js';
import { parsePrice } from '../lib/currency.js';
import type { HttpClient } from '../lib/http.js';
import { resolveIsbns, toIsbn13 } from '../lib/isbn.js';
import { normalizeLanguage } from '../lib/language.js';
import { log } from '../lib/logger.js';
import type { RawStore } from '../lib/raw-store.js';
import { cleanDescription, normalizeAuthorName, parseYear, splitTitle } from '../lib/text.js';
import { normalizeFormat } from '../normalize/format.js';
import { frontImage, isHttpUrl } from '../normalize/image.js';
import { ScraperAdapter, ScrapeNotPermittedError } from '../scrapers/base.js';
import { extractSchemaOrgBooks } from '../scrapers/publisher/schema-org.js';
import { emptySignals } from '../scoring/popularity.js';
import type { BookDataProvider, EnrichmentTarget, FetchedItem, NormalizeResult, ProviderBook } from './types.js';

/**
 * Publisher/official-store pages, read via schema.org JSON-LD only, for sites the
 * operator explicitly enabled after reviewing their terms (config/publishers.json).
 */
export class PublisherProvider implements BookDataProvider {
  readonly name = 'publisher';
  private readonly sites: Array<{ cfg: PublisherSiteConfig; adapter: ScraperAdapter }>;

  constructor(
    private readonly http: HttpClient,
    sites: PublisherSiteConfig[],
    userAgent: string,
  ) {
    this.sites = sites
      .filter((s) => s.enabled && s.terms_reviewed)
      .map((cfg) => ({ cfg, adapter: new ScraperAdapter(cfg.name, http, userAgent, { termsReviewed: cfg.terms_reviewed, minDelayMs: cfg.min_delay_ms ?? 2000 }) }));
  }

  isEnabled(): boolean {
    return this.sites.length > 0;
  }

  disabledReason(): string | null {
    return this.isEnabled() ? null : 'no publisher sites enabled with terms_reviewed=true in config/publishers.json';
  }

  async enrichByIsbn(target: EnrichmentTarget, queryId: string | null): Promise<FetchedItem[]> {
    const out: FetchedItem[] = [];
    for (const { cfg, adapter } of this.sites) {
      const url = cfg.url_template.replace('{isbn13}', target.isbn_13).replace('{isbn10}', target.isbn_10 ?? '');
      if (cfg.url_template.includes('{isbn10}') && !target.isbn_10) continue;
      try {
        const page = await adapter.fetchPage(url);
        if (page.status !== 200) continue;
        out.push({
          source: this.name,
          item_key: `${cfg.name}:${target.isbn_13}`,
          role: 'enrichment',
          query_id: queryId,
          rank: null,
          total: null,
          raw_refs: [page.ref],
          locator: { site: cfg.name, isbn_13: target.isbn_13, url, default_currency: cfg.default_currency ?? '' },
          hints: null,
          fetched_at: page.fetchedAt,
        });
      } catch (e) {
        if (e instanceof ScrapeNotPermittedError) log.warn('publisher fetch skipped', { site: cfg.name, reason: e.message });
        else log.warn('publisher fetch failed', { site: cfg.name, error: String(e) });
      }
    }
    return out;
  }

  async searchBooks(): Promise<ProviderBook[]> {
    return []; // publisher pages are looked up by ISBN only
  }

  async getBookByISBN(isbn: string): Promise<ProviderBook | null> {
    const isbn13 = toIsbn13(isbn);
    if (!isbn13) return null;
    const items = await this.enrichByIsbn({ isbn_13: isbn13, isbn_10: null }, null);
    const rec = items.flatMap((i) => this.normalizeItem(i, this.http.rawStore).records)[0] as EditionSourceRecord | undefined;
    return rec ? { work: null, editions: [rec] } : null;
  }

  async getBookById(id: string): Promise<ProviderBook | null> {
    const isbn = id.split(':').pop();
    return isbn ? this.getBookByISBN(isbn) : null;
  }

  normalizeItem(item: FetchedItem, store: RawStore): NormalizeResult {
    const env = item.raw_refs[0] ? store.read<string>(item.raw_refs[0]) : null;
    if (!env || env.status !== 200 || typeof env.body !== 'string') return { records: [], rejected: [] };
    const target = String(item.locator.isbn_13);
    const books = extractSchemaOrgBooks(env.body);
    // Only accept a JSON-LD product whose ISBN matches the ISBN we asked for.
    const book = books.find((b) => b.isbns.some((i) => toIsbn13(i) === target));
    if (!book || !book.name) return { records: [], rejected: [] };
    const isbns = resolveIsbns(
      book.isbns.filter((i) => i.replace(/-/g, '').length === 10),
      book.isbns.filter((i) => i.replace(/-/g, '').length === 13),
    );
    const split = splitTitle(book.name);
    const url = String(item.locator.url);
    const parsed = book.offer ? parsePrice(String(book.offer.price), book.offer.priceCurrency ?? (String(item.locator.default_currency) || undefined)) : null;
    const format = normalizeFormat(book.bookFormat);
    const rec: EditionSourceRecord = {
      record_type: 'edition',
      source: this.name,
      source_id: item.item_key,
      source_url: url,
      raw_ref: item.raw_refs[0]!,
      retrieved_at: env.fetched_at,
      title: split.title,
      subtitle: split.subtitle,
      authors: book.authors.map(normalizeAuthorName),
      description: cleanDescription(book.description),
      categories_raw: book.genres,
      subjects_raw: [],
      images: [frontImage(book.image && isHttpUrl(book.image) ? book.image : null, this.name, env.fetched_at)].filter((i): i is ImageRef => !!i),
      signals: { ...emptySignals(), retailer_available: parsed !== null },
      discovery: [],
      identifiers: { google_books_id: null, open_library_work_id: null, open_library_edition_id: null, asin: null },
      warnings: isbns.invalid.length ? [`invalid_isbn:${isbns.invalid.join('|')}`] : [],
      isbn_10: isbns.isbn_10,
      isbn_13: isbns.isbn_13,
      publisher: book.publisher,
      publication_year: parseYear(book.datePublished),
      first_publication_year: null,
      language: normalizeLanguage(book.inLanguage),
      page_count: book.numberOfPages,
      format,
      edition_name: null,
      price: parsed
        ? {
            ...parsed,
            source: this.name,
            offer_format: format,
            buy_url: book.offer?.url && isHttpUrl(book.offer.url) ? book.offer.url : url,
            retrieved_at: env.fetched_at,
            raw: String(book.offer!.price),
          }
        : null,
    };
    return { records: [rec], rejected: [] };
  }
}
