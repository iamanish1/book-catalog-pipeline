import type { AppEnv } from '../config/env.js';
import type { DiscoveryHit, EditionSourceRecord, ImageRef, SourceRecord, WorkSourceRecord } from '../domain/types.js';
import type { HttpClient, HttpResult } from '../lib/http.js';
import { resolveIsbns, toIsbn13 } from '../lib/isbn.js';
import { normalizeLanguage } from '../lib/language.js';
import type { RawEnvelope, RawStore } from '../lib/raw-store.js';
import { cleanDescription, collapseWhitespace, normalizeAuthorName, parseYear, splitTitle } from '../lib/text.js';
import { normalizeFormat } from '../normalize/format.js';
import { frontImage, openLibraryCoverUrl } from '../normalize/image.js';
import { emptySignals } from '../scoring/popularity.js';
import type { BookDataProvider, EnrichmentTarget, FetchedItem, NormalizeResult, ProviderBook, ResolvedDiscoveryQuery } from './types.js';
import { toProviderBooks } from './types.js';

const BASE = 'https://openlibrary.org';
const SEARCH_FIELDS = [
  'key', 'title', 'subtitle', 'author_name', 'author_key', 'first_publish_year', 'edition_count', 'cover_i',
  'cover_edition_key', 'isbn', 'language', 'subject', 'ratings_average', 'ratings_count', 'readinglog_count',
  'want_to_read_count', 'currently_reading_count', 'already_read_count',
].join(',');

/* Minimal typings for the parts of Open Library responses we use. */
interface OlSearchDoc {
  key: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  first_publish_year?: number;
  edition_count?: number;
  cover_i?: number;
  isbn?: string[];
  language?: string[];
  subject?: string[];
  ratings_average?: number;
  ratings_count?: number;
  readinglog_count?: number;
}
interface OlSearch {
  numFound?: number;
  docs?: OlSearchDoc[];
}
interface OlText {
  type?: string;
  value?: string;
}
interface OlWork {
  key?: string;
  title?: string;
  subtitle?: string;
  description?: string | OlText;
  subjects?: string[];
  covers?: number[];
  first_publish_date?: string;
  authors?: Array<{ author?: { key?: string } }>;
}
interface OlEdition {
  key?: string;
  title?: string;
  subtitle?: string;
  works?: Array<{ key?: string }>;
  publishers?: string[];
  publish_date?: string;
  isbn_10?: string[];
  isbn_13?: string[];
  languages?: Array<{ key?: string }>;
  number_of_pages?: number;
  physical_format?: string;
  edition_name?: string;
  covers?: number[];
  description?: string | OlText;
  subjects?: string[];
}
interface OlAuthor {
  name?: string;
  personal_name?: string;
}

const olId = (key: string | undefined) => (key ? key.split('/').pop() ?? null : null);
const textOf = (d: string | OlText | undefined) => (typeof d === 'string' ? d : d?.value ?? null);

const JUNK_PUBLISHER = /^(no idea|unknown|n\/?a|none|\[?s\.\s?n\.?\]?|publisher not identified|self|independently published\?)$/i;
const DERIVATIVE = /\b(summary|summaries|study guide|workbook|analysis of|concise|abridged|sparknotes|cliffs ?notes|key takeaways|companion to|notes on|quick read|book review)\b/i;

export class OpenLibraryProvider implements BookDataProvider {
  readonly name = 'open_library';

  constructor(
    private readonly http: HttpClient,
    private readonly env: Pick<AppEnv, 'openLibraryEditionsPerWork'>,
  ) {}

  isEnabled(): boolean {
    return true;
  }

  disabledReason(): string | null {
    return null;
  }

  private get<T>(url: string, kind: string, cacheKey: string): Promise<HttpResult<T>> {
    return this.http.getJson<T>(url, { source: this.name, kind, cacheClass: 'metadata', cacheKey });
  }

  private searchUrl(q: string, limit: number, page: number, sort?: string): string {
    const p = new URLSearchParams({ q, limit: String(limit), page: String(page), fields: SEARCH_FIELDS });
    if (sort) p.set('sort', sort);
    return `${BASE}/search.json?${p}`;
  }

  private async fetchWorkBundle(workId: string): Promise<{ workRef: string; editionsRef: string }> {
    const work = await this.get<OlWork>(`${BASE}/works/${workId}.json`, 'work', `work:${workId}`);
    const eds = await this.get(`${BASE}/works/${workId}/editions.json?limit=50`, 'editions', `editions:${workId}:50`);
    return { workRef: work.ref, editionsRef: eds.ref };
  }

  async discover(query: ResolvedDiscoveryQuery): Promise<FetchedItem[]> {
    const q = query.open_library?.q ?? (query.subject ? `subject:"${query.subject}"` : null);
    if (!q) return [];
    const sort = query.open_library?.sort ?? 'readinglog';
    const perPage = Math.min(100, query.limit);
    const items: FetchedItem[] = [];
    for (let page = 1; items.length < query.limit; page++) {
      const res = await this.get<OlSearch>(this.searchUrl(q, perPage, page, sort), 'search', `search:${q}:${sort}:${perPage}:${page}`);
      const docs = res.body?.docs ?? [];
      const total = res.body?.numFound ?? docs.length;
      for (let i = 0; i < docs.length && items.length < query.limit; i++) {
        const workId = olId(docs[i]!.key);
        if (!workId) continue;
        const { workRef, editionsRef } = await this.fetchWorkBundle(workId);
        items.push({
          source: this.name,
          item_key: workId,
          role: 'discovery',
          query_id: query.id,
          rank: (page - 1) * perPage + i + 1,
          total,
          raw_refs: [res.ref, workRef, editionsRef],
          locator: { doc_index: i },
          hints: { category: query.category, subcategory: query.subcategory, genre: query.genre, language: query.language ?? null },
          fetched_at: new Date().toISOString(),
        });
      }
      if (docs.length < perPage) break;
    }
    return items;
  }

  async searchBooks(query: string, limit = 10): Promise<ProviderBook[]> {
    const items = await this.discover({ id: `adhoc:${query}`, category: null, subcategory: null, genre: null, limit, open_library: { q: query, sort: '' } });
    return items.flatMap((it) => toProviderBooks(this.normalizeItem(it, this.http.rawStore).records));
  }

  async getBookByISBN(isbn: string): Promise<ProviderBook | null> {
    const isbn13 = toIsbn13(isbn);
    if (!isbn13) return null;
    const item = await this.isbnItem(isbn13, null);
    return item ? toProviderBooks(this.normalizeItem(item, this.http.rawStore).records)[0] ?? null : null;
  }

  /** Link an ISBN found elsewhere (e.g. a Google Books discovery) to its Open Library work + edition. */
  async enrichByIsbn(target: EnrichmentTarget, queryId: string | null): Promise<FetchedItem[]> {
    const item = await this.isbnItem(target.isbn_13, queryId);
    return item ? [item] : [];
  }

  private async isbnItem(isbn13: string, queryId: string | null): Promise<FetchedItem | null> {
    const ed = await this.get<OlEdition>(`${BASE}/isbn/${isbn13}.json`, 'isbn', `isbn:${isbn13}`);
    if (ed.status !== 200 || !ed.body?.key) return null;
    const item = await this.editionItem(ed, isbn13);
    if (item) item.query_id = queryId;
    return item;
  }

  async getBookById(id: string): Promise<ProviderBook | null> {
    if (/^OL\d+W$/.test(id)) {
      const search = await this.get<OlSearch>(this.searchUrl(`key:/works/${id}`, 1, 1), 'search', `search:key:${id}`);
      const { workRef, editionsRef } = await this.fetchWorkBundle(id);
      const work = this.http.rawStore.read<OlWork>(workRef);
      if (!work || work.status !== 200) return null;
      const item = this.adhocItem(id, [search.ref, workRef, editionsRef]);
      return toProviderBooks(this.normalizeItem(item, this.http.rawStore).records)[0] ?? null;
    }
    if (/^OL\d+M$/.test(id)) {
      const ed = await this.get<OlEdition>(`${BASE}/books/${id}.json`, 'edition', `edition:${id}`);
      if (ed.status !== 200) return null;
      const item = await this.editionItem(ed, null);
      return item ? toProviderBooks(this.normalizeItem(item, this.http.rawStore).records)[0] ?? null : null;
    }
    return null;
  }

  private async editionItem(ed: HttpResult<OlEdition>, isbn13: string | null): Promise<FetchedItem | null> {
    const workId = olId(ed.body.works?.[0]?.key);
    if (!workId) return null;
    const search = await this.get<OlSearch>(
      this.searchUrl(isbn13 ? `isbn:${isbn13}` : `key:/works/${workId}`, 1, 1),
      'search',
      isbn13 ? `search:isbn:${isbn13}` : `search:key:${workId}`,
    );
    const work = await this.get<OlWork>(`${BASE}/works/${workId}.json`, 'work', `work:${workId}`);
    const refs = [search.ref, work.ref, ed.ref];
    const hasAuthors = (search.body?.docs?.[0]?.author_name?.length ?? 0) > 0;
    if (!hasAuthors) {
      for (const a of (work.body?.authors ?? []).slice(0, 5)) {
        const key = olId(a.author?.key);
        if (key) refs.push((await this.get<OlAuthor>(`${BASE}/authors/${key}.json`, 'author', `author:${key}`)).ref);
      }
    }
    const item = this.adhocItem(workId, refs);
    item.locator = { doc_index: 0, mode: 'single_edition' };
    return item;
  }

  private adhocItem(workId: string, refs: string[]): FetchedItem {
    return {
      source: this.name,
      item_key: workId,
      role: 'enrichment',
      query_id: null,
      rank: null,
      total: null,
      raw_refs: refs,
      locator: { doc_index: 0 },
      hints: null,
      fetched_at: new Date().toISOString(),
    };
  }

  /* ---------------------------- normalization ---------------------------- */

  normalizeItem(item: FetchedItem, store: RawStore): NormalizeResult {
    const [searchRef, workRef, editionsRef, ...extraRefs] = item.raw_refs;
    const search = searchRef ? store.read<OlSearch>(searchRef) : null;
    const workEnv = workRef ? store.read<OlWork>(workRef) : null;
    const edEnv = editionsRef ? store.read<{ entries?: OlEdition[] } | OlEdition>(editionsRef) : null;
    const authorEnvs = extraRefs.map((r) => store.read<OlAuthor>(r)).filter((e): e is RawEnvelope<OlAuthor> => !!e);

    const docs = search?.body?.docs ?? [];
    const doc = docs.find((d) => olId(d.key) === item.item_key) ?? null;
    const work = workEnv && workEnv.status === 200 ? workEnv.body : null;
    if (!work && !doc) return { records: [], rejected: [] };

    const retrievedAt = workEnv?.fetched_at ?? search?.fetched_at ?? item.fetched_at;
    const rawTitle = collapseWhitespace(work?.title ?? doc?.title ?? '');
    const split = splitTitle(rawTitle);
    const title = split.title;
    const subtitle = work?.subtitle ?? doc?.subtitle ?? split.subtitle;
    const authors = (doc?.author_name?.length ? doc.author_name : authorEnvs.map((a) => a.body?.name ?? a.body?.personal_name ?? ''))
      .map(normalizeAuthorName)
      .filter(Boolean);
    const subjects = [...new Set([...(work?.subjects ?? []), ...(doc?.subject ?? []).slice(0, 60)])];
    const bestseller = subjects.filter((s) => /new york times best ?seller|^nyt:/i.test(s)).length;
    const coverId = [...(work?.covers ?? []), doc?.cover_i].find((c): c is number => typeof c === 'number' && c > 0);
    const workUrl = `${BASE}/works/${item.item_key}`;

    const discovery: DiscoveryHit[] =
      item.role === 'discovery' && item.query_id && item.rank
        ? [
            {
              query_id: item.query_id,
              source: this.name,
              rank: item.rank,
              total: item.total ?? item.rank,
              category_hint: item.hints?.category ?? null,
              subcategory_hint: item.hints?.subcategory ?? null,
              genre_hint: item.hints?.genre ?? null,
            },
          ]
        : [];

    const workRecord: WorkSourceRecord = {
      record_type: 'work',
      source: this.name,
      source_id: item.item_key,
      source_url: workUrl,
      raw_ref: workRef ?? searchRef ?? null,
      retrieved_at: retrievedAt,
      title,
      subtitle: subtitle ? collapseWhitespace(subtitle) : null,
      authors,
      description: cleanDescription(textOf(work?.description)),
      categories_raw: [],
      subjects_raw: subjects,
      images: [frontImage(coverId ? openLibraryCoverUrl(coverId) : null, this.name, retrievedAt)].filter((i): i is ImageRef => !!i),
      signals: {
        ...emptySignals(),
        average_rating: doc?.ratings_average ?? null,
        ratings_count: doc?.ratings_count ?? null,
        edition_count: doc?.edition_count ?? null,
        readinglog_count: doc?.readinglog_count ?? null,
        bestseller_mentions: bestseller,
      },
      discovery,
      identifiers: { google_books_id: null, open_library_work_id: item.item_key, open_library_edition_id: null, asin: null },
      warnings: [],
      first_publication_year: doc?.first_publish_year ?? parseYear(work?.first_publish_date),
      known_isbn13s: [...new Set((doc?.isbn ?? []).map((i) => toIsbn13(i)).filter((i): i is string => !!i))].slice(0, 2000),
      language: null,
    };

    const rawEditions: OlEdition[] = !edEnv || edEnv.status !== 200
      ? []
      : 'entries' in edEnv.body && Array.isArray(edEnv.body.entries)
        ? edEnv.body.entries
        : [edEnv.body as OlEdition];
    const singleEdition = item.locator.mode === 'single_edition';
    const preferredLang = item.hints?.language ?? null;

    const candidates: Array<{ rec: EditionSourceRecord; score: number }> = [];
    const rejected: NormalizeResult['rejected'] = [];
    for (const e of rawEditions) {
      const rec = this.editionRecord(e, workRecord, edEnv!, item.item_key, editionsRef ?? null);
      if (!rec) continue;
      const reason = singleEdition ? null : this.rejectReason(rec, workRecord);
      if (reason) {
        rejected.push({ record: rec, reason });
        continue;
      }
      if (!rec.isbn_13 && !singleEdition) continue; // commerce catalog: editions need an ISBN
      let score = 0;
      if (rec.isbn_13) score += 4;
      if (rec.images.length) score += 3;
      if (rec.publisher) score += 2;
      if (rec.page_count) score += 1;
      if (rec.format) score += 1;
      if (preferredLang && rec.language === preferredLang) score += 3;
      else if (!preferredLang && rec.language === 'en') score += 1;
      score += (rec.publication_year ?? 1900) / 10000;
      candidates.push({ rec, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    const keep = singleEdition ? candidates : candidates.slice(0, this.env.openLibraryEditionsPerWork);
    if (candidates.length > keep.length) workRecord.warnings.push(`editions_truncated:${candidates.length - keep.length}`);

    const records: SourceRecord[] = [workRecord, ...keep.map((c) => c.rec)];
    return { records, rejected };
  }

  /**
   * Exclude editions whose title shows a different product (summaries, study guides, knock-offs).
   * A differing title alone is not grounds for rejection: translations and original-language work
   * titles (an English edition under a Russian work title) are legitimate editions of the work.
   */
  private rejectReason(ed: EditionSourceRecord, work: WorkSourceRecord): string | null {
    const full = `${ed.title} ${ed.subtitle ?? ''}`;
    if (DERIVATIVE.test(full) && !DERIVATIVE.test(`${work.title} ${work.subtitle ?? ''}`)) return 'derivative_title';
    return null;
  }

  private editionRecord(e: OlEdition, work: WorkSourceRecord, env: RawEnvelope, workId: string, ref: string | null): EditionSourceRecord | null {
    const editionId = olId(e.key);
    if (!editionId || !e.title) return null;
    const warnings: string[] = [];
    const isbns = resolveIsbns(e.isbn_10 ?? [], e.isbn_13 ?? []);
    if (isbns.invalid.length) warnings.push(`invalid_isbn:${isbns.invalid.join('|')}`);
    if (isbns.extra13.length) warnings.push(`multiple_isbn13:${isbns.extra13.join('|')}`);
    let publisher = e.publishers?.[0] ? collapseWhitespace(e.publishers[0]) : null;
    if (publisher && JUNK_PUBLISHER.test(publisher)) {
      warnings.push(`junk_publisher:${publisher}`);
      publisher = null;
    }
    const pages = typeof e.number_of_pages === 'number' && e.number_of_pages > 0 && e.number_of_pages < 20000 ? e.number_of_pages : null;
    const split = splitTitle(e.title);
    const coverId = e.covers?.find((c) => c > 0);
    return {
      record_type: 'edition',
      source: this.name,
      source_id: editionId,
      source_url: `${BASE}/books/${editionId}`,
      raw_ref: ref,
      retrieved_at: env.fetched_at,
      title: split.title,
      subtitle: e.subtitle ? collapseWhitespace(e.subtitle) : split.subtitle,
      authors: work.authors,
      description: cleanDescription(textOf(e.description)),
      categories_raw: [],
      subjects_raw: e.subjects ?? [],
      images: [frontImage(coverId ? openLibraryCoverUrl(coverId) : null, this.name, env.fetched_at)].filter((i): i is ImageRef => !!i),
      signals: emptySignals(),
      discovery: [],
      identifiers: { google_books_id: null, open_library_work_id: workId, open_library_edition_id: editionId, asin: null },
      warnings,
      isbn_10: isbns.isbn_10,
      isbn_13: isbns.isbn_13,
      publisher,
      publication_year: parseYear(e.publish_date),
      first_publication_year: work.first_publication_year,
      language: normalizeLanguage(e.languages?.[0]?.key),
      page_count: pages,
      format: normalizeFormat(e.physical_format),
      edition_name: e.edition_name ? collapseWhitespace(e.edition_name) : null,
      price: null,
    };
  }
}
