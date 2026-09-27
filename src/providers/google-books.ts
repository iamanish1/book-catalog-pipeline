import type { AppEnv } from '../config/env.js';
import type { DiscoveryHit, EditionSourceRecord, ImageRef, PriceOffer } from '../domain/types.js';
import { isValidCurrency, round2 } from '../lib/currency.js';
import type { HttpClient } from '../lib/http.js';
import { resolveIsbns, toIsbn13 } from '../lib/isbn.js';
import { normalizeLanguage } from '../lib/language.js';
import type { RawStore } from '../lib/raw-store.js';
import { cleanDescription, collapseWhitespace, normalizeAuthorName, parseYear, splitTitle } from '../lib/text.js';
import { frontImage, isHttpUrl } from '../normalize/image.js';
import { emptySignals } from '../scoring/popularity.js';
import type { BookDataProvider, EnrichmentTarget, FetchedItem, NormalizeResult, ProviderBook, ResolvedDiscoveryQuery } from './types.js';

const BASE = 'https://www.googleapis.com/books/v1';

interface Money {
  amount?: number;
  amountInMicros?: number;
  currencyCode?: string;
}
export interface GbVolume {
  id: string;
  selfLink?: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
    pageCount?: number;
    printType?: string;
    categories?: string[];
    mainCategory?: string;
    averageRating?: number;
    ratingsCount?: number;
    imageLinks?: Record<string, string>;
    language?: string;
    infoLink?: string;
    canonicalVolumeLink?: string;
  };
  saleInfo?: {
    country?: string;
    saleability?: string;
    isEbook?: boolean;
    listPrice?: Money;
    retailPrice?: Money;
    buyLink?: string;
  };
}
interface GbList {
  totalItems?: number;
  items?: GbVolume[];
}

const IMAGE_PREFERENCE = ['extraLarge', 'large', 'medium', 'small', 'thumbnail', 'smallThumbnail'];

export class GoogleBooksProvider implements BookDataProvider {
  readonly name = 'google_books';

  constructor(
    private readonly http: HttpClient,
    private readonly env: Pick<AppEnv, 'googleBooksApiKey' | 'googleBooksCountry'>,
  ) {}

  isEnabled(): boolean {
    return this.env.googleBooksApiKey !== '';
  }

  disabledReason(): string | null {
    return this.isEnabled() ? null : 'GOOGLE_BOOKS_API_KEY not set (anonymous quota is not reliable)';
  }

  private url(pathname: string, params: Record<string, string>): string {
    const p = new URLSearchParams({ ...params, country: this.env.googleBooksCountry, key: this.env.googleBooksApiKey });
    return `${BASE}${pathname}?${p}`;
  }

  /** Cache keys never contain the API key. */
  private async list(params: Record<string, string>, kind: string) {
    const cacheKey = `${kind}:${this.env.googleBooksCountry}:${new URLSearchParams(params)}`;
    return this.http.getJson<GbList>(this.url('/volumes', params), { source: this.name, kind, cacheClass: 'metadata', cacheKey });
  }

  async discover(query: ResolvedDiscoveryQuery): Promise<FetchedItem[]> {
    if (!this.isEnabled()) return [];
    const q = query.google_books?.q ?? (query.subject ? `subject:"${query.subject}"` : null);
    if (!q) return [];
    const items: FetchedItem[] = [];
    const pageSize = 40; // API maximum
    for (let start = 0; items.length < query.limit; start += pageSize) {
      const params: Record<string, string> = {
        q,
        startIndex: String(start),
        maxResults: String(Math.min(pageSize, query.limit - items.length)),
        orderBy: query.google_books?.orderBy ?? 'relevance',
        printType: query.google_books?.printType ?? 'books',
      };
      if (query.google_books?.langRestrict) params.langRestrict = query.google_books.langRestrict;
      const res = await this.list(params, 'search');
      const vols = res.body?.items ?? [];
      vols.forEach((v, i) => {
        items.push({
          source: this.name,
          item_key: v.id,
          role: 'discovery',
          query_id: query.id,
          rank: start + i + 1,
          total: res.body?.totalItems ?? vols.length,
          raw_refs: [res.ref],
          locator: { item_index: i },
          hints: { category: query.category, subcategory: query.subcategory, genre: query.genre, language: query.language ?? null },
          fetched_at: res.fetchedAt,
        });
      });
      if (vols.length === 0 || start + pageSize >= (res.body?.totalItems ?? 0)) break;
    }
    return items.slice(0, query.limit);
  }

  async enrichByIsbn(target: EnrichmentTarget, queryId: string | null): Promise<FetchedItem[]> {
    if (!this.isEnabled()) return [];
    const res = await this.list({ q: `isbn:${target.isbn_13}`, maxResults: '5' }, 'isbn');
    return (res.body?.items ?? []).map((v, i) => ({
      source: this.name,
      item_key: v.id,
      role: 'enrichment' as const,
      query_id: queryId,
      rank: null,
      total: null,
      raw_refs: [res.ref],
      locator: { item_index: i, isbn_13: target.isbn_13 },
      hints: null,
      fetched_at: res.fetchedAt,
    }));
  }

  async searchBooks(query: string, limit = 10): Promise<ProviderBook[]> {
    const items = await this.discover({ id: `adhoc:${query}`, category: null, subcategory: null, genre: null, limit, google_books: { q: query } });
    return this.toBooks(items);
  }

  async getBookByISBN(isbn: string): Promise<ProviderBook | null> {
    const isbn13 = toIsbn13(isbn);
    if (!isbn13 || !this.isEnabled()) return null;
    const books = this.toBooks(await this.enrichByIsbn({ isbn_13: isbn13, isbn_10: null }, null));
    return books.find((b) => b.editions[0]?.isbn_13 === isbn13) ?? books[0] ?? null;
  }

  async getBookById(id: string): Promise<ProviderBook | null> {
    if (!this.isEnabled() || !/^[\w-]{6,20}$/.test(id)) return null;
    const res = await this.http.getJson<GbVolume>(this.url(`/volumes/${id}`, {}), {
      source: this.name,
      kind: 'volume',
      cacheClass: 'metadata',
      cacheKey: `volume:${this.env.googleBooksCountry}:${id}`,
    });
    if (res.status !== 200 || !res.body?.id) return null;
    const rec = this.volumeToRecord(res.body, res.ref, res.fetchedAt, null);
    return rec ? { work: null, editions: [rec] } : null;
  }

  private toBooks(items: FetchedItem[]): ProviderBook[] {
    return items.flatMap((it) => this.normalizeItem(it, this.http.rawStore).records).map((r) => ({ work: null, editions: [r as EditionSourceRecord] }));
  }

  normalizeItem(item: FetchedItem, store: RawStore): NormalizeResult {
    const ref = item.raw_refs[0];
    const env = ref ? store.read<GbList | GbVolume>(ref) : null;
    if (!env || env.status !== 200) return { records: [], rejected: [] };
    const body = env.body;
    const vol = 'items' in body || 'totalItems' in body ? (body as GbList).items?.[Number(item.locator.item_index)] : (body as GbVolume);
    if (!vol || vol.id !== item.item_key) return { records: [], rejected: [] };
    const hit: DiscoveryHit | null =
      item.role === 'discovery' && item.query_id && item.rank
        ? {
            query_id: item.query_id,
            source: this.name,
            rank: item.rank,
            total: item.total ?? item.rank,
            category_hint: item.hints?.category ?? null,
            subcategory_hint: item.hints?.subcategory ?? null,
            genre_hint: item.hints?.genre ?? null,
          }
        : null;
    const rec = this.volumeToRecord(vol, ref!, env.fetched_at, hit);
    return { records: rec ? [rec] : [], rejected: [] };
  }

  volumeToRecord(vol: GbVolume, ref: string, retrievedAt: string, hit: DiscoveryHit | null): EditionSourceRecord | null {
    const vi = vol.volumeInfo ?? {};
    if (!vi.title) return null;
    const warnings: string[] = [];
    const ids = vi.industryIdentifiers ?? [];
    const isbns = resolveIsbns(
      ids.filter((i) => i.type === 'ISBN_10').map((i) => i.identifier ?? ''),
      ids.filter((i) => i.type === 'ISBN_13').map((i) => i.identifier ?? ''),
    );
    if (isbns.invalid.length) warnings.push(`invalid_isbn:${isbns.invalid.join('|')}`);

    const split = vi.subtitle ? { title: collapseWhitespace(vi.title), subtitle: collapseWhitespace(vi.subtitle) } : splitTitle(vi.title);
    const imageUrl = IMAGE_PREFERENCE.map((k) => vi.imageLinks?.[k]).find(isHttpUrl);
    const sale = vol.saleInfo ?? {};
    const buyUrl = isHttpUrl(sale.buyLink) ? sale.buyLink : null;
    const infoUrl = [vi.canonicalVolumeLink, vi.infoLink].find(isHttpUrl) ?? `https://books.google.com/books?id=${vol.id}`;

    return {
      record_type: 'edition',
      source: this.name,
      source_id: vol.id,
      source_url: infoUrl,
      raw_ref: ref,
      retrieved_at: retrievedAt,
      title: split.title,
      subtitle: split.subtitle,
      authors: (vi.authors ?? []).map(normalizeAuthorName).filter(Boolean),
      description: cleanDescription(vi.description),
      categories_raw: [...(vi.categories ?? []), ...(vi.mainCategory ? [vi.mainCategory] : [])],
      subjects_raw: [],
      images: [frontImage(imageUrl, this.name, retrievedAt)].filter((i): i is ImageRef => !!i),
      signals: {
        ...emptySignals(),
        average_rating: typeof vi.averageRating === 'number' ? vi.averageRating : null,
        ratings_count: typeof vi.ratingsCount === 'number' ? vi.ratingsCount : null,
        retailer_available: sale.saleability ? sale.saleability === 'FOR_SALE' || sale.saleability === 'FOR_PREORDER' : null,
      },
      discovery: hit ? [hit] : [],
      identifiers: { google_books_id: vol.id, open_library_work_id: null, open_library_edition_id: null, asin: null },
      warnings,
      isbn_10: isbns.isbn_10,
      isbn_13: isbns.isbn_13,
      publisher: vi.publisher ? collapseWhitespace(vi.publisher) : null,
      publication_year: parseYear(vi.publishedDate),
      first_publication_year: null,
      language: normalizeLanguage(vi.language),
      page_count: typeof vi.pageCount === 'number' && vi.pageCount > 0 ? vi.pageCount : null,
      // Google Books does not report print binding; do not guess.
      format: null,
      edition_name: null,
      price: gbPrice(sale, buyUrl, retrievedAt),
    };
  }
}

/** Google Books saleInfo prices are Google Play offers — for the eBook when isEbook is true. */
export function gbPrice(sale: NonNullable<GbVolume['saleInfo']>, buyUrl: string | null, retrievedAt: string): PriceOffer | null {
  if (sale.saleability !== 'FOR_SALE' && sale.saleability !== 'FOR_PREORDER') return null;
  const m = sale.retailPrice ?? sale.listPrice;
  if (!m || !isValidCurrency(m.currencyCode)) return null;
  const amount = typeof m.amount === 'number' ? m.amount : typeof m.amountInMicros === 'number' ? m.amountInMicros / 1e6 : null;
  if (amount === null || amount < 0) return null;
  return {
    amount: round2(amount),
    currency: m.currencyCode,
    source: 'google_books',
    offer_format: sale.isEbook ? 'eBook' : null,
    buy_url: buyUrl,
    retrieved_at: retrievedAt,
    raw: JSON.stringify(m),
  };
}
