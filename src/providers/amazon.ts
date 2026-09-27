import crypto from 'node:crypto';
import type { AppEnv } from '../config/env.js';
import type { DiscoveryHit, EditionSourceRecord, ImageRef } from '../domain/types.js';
import { isValidCurrency, round2 } from '../lib/currency.js';
import type { HttpClient } from '../lib/http.js';
import { resolveIsbns, toIsbn13 } from '../lib/isbn.js';
import { normalizeLanguage } from '../lib/language.js';
import type { RawStore } from '../lib/raw-store.js';
import { collapseWhitespace, normalizeAuthorName, parseYear, splitTitle } from '../lib/text.js';
import { normalizeFormat } from '../normalize/format.js';
import { frontImage, isHttpUrl } from '../normalize/image.js';
import { emptySignals } from '../scoring/popularity.js';
import type { BookDataProvider, EnrichmentTarget, FetchedItem, NormalizeResult, ProviderBook, ResolvedDiscoveryQuery } from './types.js';

/**
 * Amazon Product Advertising API 5.0 provider (official API; no scraping).
 * Disabled unless AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY and AMAZON_PARTNER_TAG are set.
 * Amazon evolves this API; confirm the endpoint/version in Amazon's current docs before enabling.
 */
const RESOURCES = [
  'ItemInfo.Title',
  'ItemInfo.ByLineInfo',
  'ItemInfo.ExternalIds',
  'ItemInfo.ContentInfo',
  'ItemInfo.Classifications',
  'Images.Primary.Large',
  'Offers.Listings.Price',
  'BrowseNodeInfo.BrowseNodes',
];

interface DisplayValue<T = string> {
  DisplayValue?: T;
}
export interface PaapiItem {
  ASIN: string;
  DetailPageURL?: string;
  Images?: { Primary?: { Large?: { URL?: string } } };
  ItemInfo?: {
    Title?: DisplayValue;
    ByLineInfo?: { Contributors?: Array<{ Name?: string; Role?: string }>; Manufacturer?: DisplayValue; Brand?: DisplayValue };
    ExternalIds?: { ISBNs?: { DisplayValues?: string[] }; EANs?: { DisplayValues?: string[] } };
    ContentInfo?: {
      PagesCount?: DisplayValue<number>;
      PublicationDate?: DisplayValue;
      Languages?: { DisplayValues?: Array<{ DisplayValue?: string; Type?: string }> };
      Edition?: DisplayValue;
    };
    Classifications?: { Binding?: DisplayValue; ProductGroup?: DisplayValue };
  };
  Offers?: { Listings?: Array<{ Price?: { Amount?: number; Currency?: string; DisplayAmount?: string } }> };
  BrowseNodeInfo?: { BrowseNodes?: Array<{ DisplayName?: string }> };
}
interface PaapiResponse {
  SearchResult?: { TotalResultCount?: number; Items?: PaapiItem[] };
  ItemsResult?: { Items?: PaapiItem[] };
  Errors?: Array<{ Code?: string; Message?: string }>;
}

const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha256hex = (data: string) => crypto.createHash('sha256').update(data, 'utf8').digest('hex');

/** AWS Signature Version 4 headers for a PA-API request. Exported for tests. */
export function signPaapiRequest(opts: {
  accessKey: string;
  secretKey: string;
  region: string;
  host: string;
  path: string;
  target: string;
  body: string;
  now?: Date;
}): Record<string, string> {
  const service = 'ProductAdvertisingAPI';
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    'content-encoding': 'amz-1.0',
    'content-type': 'application/json; charset=utf-8',
    host: opts.host,
    'x-amz-date': amzDate,
    'x-amz-target': opts.target,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}\n`)
    .join('');
  const canonicalRequest = ['POST', opts.path, '', canonicalHeaders, signedHeaders, sha256hex(opts.body)].join('\n');
  const scope = `${dateStamp}/${opts.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.secretKey}`, dateStamp), opts.region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export class AmazonProvider implements BookDataProvider {
  readonly name = 'amazon';

  constructor(
    private readonly http: HttpClient,
    private readonly env: Pick<AppEnv, 'amazon'>,
  ) {}

  isEnabled(): boolean {
    const a = this.env.amazon;
    return Boolean(a.accessKey && a.secretKey && a.partnerTag);
  }

  disabledReason(): string | null {
    return this.isEnabled() ? null : 'AMAZON_ACCESS_KEY / AMAZON_SECRET_KEY / AMAZON_PARTNER_TAG not set';
  }

  private async call(operation: 'SearchItems' | 'GetItems', payload: Record<string, unknown>, cacheKey: string) {
    const a = this.env.amazon;
    const path = `/paapi5/${operation.toLowerCase()}`;
    const body = JSON.stringify({ ...payload, PartnerTag: a.partnerTag, PartnerType: 'Associates', Marketplace: a.marketplace, Resources: RESOURCES });
    const headers = signPaapiRequest({
      accessKey: a.accessKey,
      secretKey: a.secretKey,
      region: a.region,
      host: a.host,
      path,
      target: `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${operation}`,
      body,
    });
    delete headers.host; // set by fetch
    return this.http.getJson<PaapiResponse>(`https://${a.host}${path}`, {
      source: this.name,
      kind: operation.toLowerCase(),
      cacheClass: 'price',
      cacheKey: `${a.marketplace}:${cacheKey}`,
      method: 'POST',
      headers,
      body,
    });
  }

  async enrichByIsbn(target: EnrichmentTarget, queryId: string | null): Promise<FetchedItem[]> {
    if (!this.isEnabled()) return [];
    const res = await this.call('SearchItems', { Keywords: target.isbn_13, SearchIndex: 'Books', ItemCount: 3 }, `isbn:${target.isbn_13}`);
    return this.items(res.body?.SearchResult?.Items ?? [], res.ref, res.fetchedAt, 'enrichment', queryId, null);
  }

  async discover(query: ResolvedDiscoveryQuery): Promise<FetchedItem[]> {
    if (!this.isEnabled() || !query.subject) return [];
    const res = await this.call('SearchItems', { Keywords: query.subject, SearchIndex: 'Books', ItemCount: Math.min(10, query.limit) }, `search:${query.subject}`);
    const list = res.body?.SearchResult?.Items ?? [];
    return this.items(list, res.ref, res.fetchedAt, 'discovery', query.id, res.body?.SearchResult?.TotalResultCount ?? list.length, query);
  }

  private items(
    list: PaapiItem[],
    ref: string,
    fetchedAt: string,
    role: FetchedItem['role'],
    queryId: string | null,
    total: number | null,
    query?: ResolvedDiscoveryQuery,
  ): FetchedItem[] {
    return list.map((it, i) => ({
      source: this.name,
      item_key: it.ASIN,
      role,
      query_id: queryId,
      rank: role === 'discovery' ? i + 1 : null,
      total,
      raw_refs: [ref],
      locator: { item_index: i },
      hints: query ? { category: query.category, subcategory: query.subcategory, genre: query.genre, language: query.language ?? null } : null,
      fetched_at: fetchedAt,
    }));
  }

  async searchBooks(query: string, limit = 10): Promise<ProviderBook[]> {
    const items = await this.discover({ id: `adhoc:${query}`, category: null, subcategory: null, genre: null, subject: query, limit });
    return items.flatMap((it) => this.normalizeItem(it, this.http.rawStore).records).map((r) => ({ work: null, editions: [r as EditionSourceRecord] }));
  }

  async getBookByISBN(isbn: string): Promise<ProviderBook | null> {
    const isbn13 = toIsbn13(isbn);
    if (!isbn13 || !this.isEnabled()) return null;
    const items = await this.enrichByIsbn({ isbn_13: isbn13, isbn_10: null }, null);
    const recs = items.flatMap((it) => this.normalizeItem(it, this.http.rawStore).records) as EditionSourceRecord[];
    const hit = recs.find((r) => r.isbn_13 === isbn13);
    return hit ? { work: null, editions: [hit] } : null;
  }

  async getBookById(asin: string): Promise<ProviderBook | null> {
    if (!this.isEnabled() || !/^[A-Z0-9]{10}$/.test(asin)) return null;
    const res = await this.call('GetItems', { ItemIds: [asin], ItemIdType: 'ASIN' }, `asin:${asin}`);
    const it = res.body?.ItemsResult?.Items?.[0];
    const rec = it ? this.itemToRecord(it, res.ref, res.fetchedAt, null) : null;
    return rec ? { work: null, editions: [rec] } : null;
  }

  normalizeItem(item: FetchedItem, store: RawStore): NormalizeResult {
    const env = item.raw_refs[0] ? store.read<PaapiResponse>(item.raw_refs[0]) : null;
    if (!env || env.status !== 200) return { records: [], rejected: [] };
    const list = env.body?.SearchResult?.Items ?? env.body?.ItemsResult?.Items ?? [];
    const it = list[Number(item.locator.item_index)];
    if (!it || it.ASIN !== item.item_key) return { records: [], rejected: [] };
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
    const rec = this.itemToRecord(it, item.raw_refs[0]!, env.fetched_at, hit);
    return { records: rec ? [rec] : [], rejected: [] };
  }

  itemToRecord(it: PaapiItem, ref: string, retrievedAt: string, hit: DiscoveryHit | null): EditionSourceRecord | null {
    const info = it.ItemInfo ?? {};
    const rawTitle = info.Title?.DisplayValue;
    if (!rawTitle) return null;
    const warnings: string[] = [];
    const isbns = resolveIsbns(info.ExternalIds?.ISBNs?.DisplayValues ?? [], info.ExternalIds?.EANs?.DisplayValues ?? []);
    if (isbns.invalid.length) warnings.push(`invalid_isbn:${isbns.invalid.join('|')}`);
    const split = splitTitle(rawTitle);
    const listing = it.Offers?.Listings?.[0]?.Price;
    const binding = info.Classifications?.Binding?.DisplayValue ?? null;
    const format = normalizeFormat(binding);
    const detailUrl = isHttpUrl(it.DetailPageURL) ? it.DetailPageURL : null;
    const price =
      listing && typeof listing.Amount === 'number' && listing.Amount >= 0 && isValidCurrency(listing.Currency)
        ? {
            amount: round2(listing.Amount),
            currency: listing.Currency,
            source: this.name,
            offer_format: format,
            buy_url: detailUrl,
            retrieved_at: retrievedAt,
            raw: listing.DisplayAmount ?? null,
          }
        : null;
    const pages = info.ContentInfo?.PagesCount?.DisplayValue;
    const lang = info.ContentInfo?.Languages?.DisplayValues?.find((l) => l.Type === 'Published') ?? info.ContentInfo?.Languages?.DisplayValues?.[0];
    return {
      record_type: 'edition',
      source: this.name,
      source_id: it.ASIN,
      source_url: detailUrl,
      raw_ref: ref,
      retrieved_at: retrievedAt,
      title: split.title,
      subtitle: split.subtitle,
      authors: (info.ByLineInfo?.Contributors ?? [])
        .filter((c) => !c.Role || /author/i.test(c.Role))
        .map((c) => normalizeAuthorName(c.Name ?? ''))
        .filter(Boolean),
      description: null,
      categories_raw: (it.BrowseNodeInfo?.BrowseNodes ?? []).map((b) => b.DisplayName ?? '').filter(Boolean),
      subjects_raw: [],
      images: [frontImage(it.Images?.Primary?.Large?.URL, this.name, retrievedAt, 'Amazon Associates Program Operating Agreement')].filter(
        (i): i is ImageRef => !!i,
      ),
      signals: { ...emptySignals(), retailer_available: price !== null },
      discovery: hit ? [hit] : [],
      identifiers: { google_books_id: null, open_library_work_id: null, open_library_edition_id: null, asin: it.ASIN },
      warnings,
      isbn_10: isbns.isbn_10,
      isbn_13: isbns.isbn_13,
      publisher: info.ByLineInfo?.Manufacturer?.DisplayValue ? collapseWhitespace(info.ByLineInfo.Manufacturer.DisplayValue) : null,
      publication_year: parseYear(info.ContentInfo?.PublicationDate?.DisplayValue),
      first_publication_year: null,
      language: normalizeLanguage(lang?.DisplayValue),
      page_count: typeof pages === 'number' && pages > 0 ? pages : null,
      format,
      edition_name: info.ContentInfo?.Edition?.DisplayValue ?? null,
      price,
    };
  }
}
