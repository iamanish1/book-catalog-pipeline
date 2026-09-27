import type { SourcesConfig } from '../config/index.js';
import type { EditionSourceRecord, FieldConflict, ImageRef, MergedEdition, PriceOffer, SourceName, SourceRecord } from '../domain/types.js';
import { authorKey, foldText } from '../lib/text.js';

export interface Candidate<T> {
  source: SourceName;
  value: T;
}

export function rankOf(precedence: SourceName[] | undefined, source: SourceName): number {
  const i = precedence?.indexOf(source) ?? -1;
  return i < 0 ? 1000 : i;
}

function comparable(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? authorKey(x) || foldText(x) : String(x))).sort().join('|');
  if (typeof v === 'string') return foldText(v);
  return JSON.stringify(v);
}

/**
 * Pick one value by source precedence. Differing values from other sources are
 * returned as a conflict (kept for audit), never silently discarded.
 */
export function pick<T>(
  field: string,
  candidates: Array<Candidate<T | null | undefined>>,
  precedence: SourceName[] | undefined,
): { value: T | null; source: SourceName | null; conflict: FieldConflict | null } {
  const present = candidates.filter(
    (c): c is Candidate<T> => c.value !== null && c.value !== undefined && !(Array.isArray(c.value) && c.value.length === 0) && c.value !== '',
  );
  if (present.length === 0) return { value: null, source: null, conflict: null };
  const sorted = [...present].sort((a, b) => rankOf(precedence, a.source) - rankOf(precedence, b.source));
  const chosen = sorted[0]!;
  const seen = new Set([comparable(chosen.value)]);
  const alternatives: Array<{ source: SourceName; value: unknown }> = [];
  for (const c of sorted.slice(1)) {
    const k = comparable(c.value);
    if (seen.has(k)) continue;
    seen.add(k);
    alternatives.push({ source: c.source, value: c.value });
  }
  return {
    value: chosen.value,
    source: chosen.source,
    conflict: alternatives.length ? { field, chosen: { source: chosen.source, value: chosen.value }, alternatives } : null,
  };
}

export function editionKeyOf(e: { isbn_13: string | null; identifiers: { open_library_edition_id: string | null; google_books_id: string | null; asin: string | null } }): string {
  if (e.isbn_13) return `isbn13:${e.isbn_13}`;
  if (e.identifiers.open_library_edition_id) return `oled:${e.identifiers.open_library_edition_id}`;
  if (e.identifiers.google_books_id) return `gb:${e.identifiers.google_books_id}`;
  if (e.identifiers.asin) return `asin:${e.identifiers.asin}`;
  throw new Error('edition has no identity');
}

function dedupeOffers(offers: PriceOffer[]): PriceOffer[] {
  const byKey = new Map<string, PriceOffer>();
  for (const o of offers) {
    const k = `${o.source}|${o.currency}|${o.offer_format ?? ''}`;
    const cur = byKey.get(k);
    if (!cur || Date.parse(o.retrieved_at) > Date.parse(cur.retrieved_at)) byKey.set(k, o);
  }
  return [...byKey.values()];
}

/** Merge edition-level records that were identified as the same edition. */
export function mergeEdition(records: EditionSourceRecord[], cfg: SourcesConfig): MergedEdition {
  const p = cfg.edition_precedence;
  const field_sources: Record<string, SourceName> = {};
  const conflicts: FieldConflict[] = [];
  const take = <T>(field: string, get: (r: EditionSourceRecord) => T | null | undefined, prec: SourceName[] | undefined): T | null => {
    const r = pick(field, records.map((rec) => ({ source: rec.source, value: get(rec) })), prec);
    if (r.source) field_sources[field] = r.source;
    if (r.conflict) conflicts.push(r.conflict);
    return r.value;
  };
  const isbn13 = take('isbn_13', (r) => r.isbn_13, p.isbn);
  const isbn10 = take('isbn_10', (r) => r.isbn_10, p.isbn);
  const images = records
    .flatMap((r) => r.images)
    .sort((a, b) => rankOf(p.front_image, a.source) - rankOf(p.front_image, b.source));
  const uniqImages: ImageRef[] = [];
  for (const img of images) if (!uniqImages.some((u) => u.url === img.url)) uniqImages.push(img);
  const front = uniqImages.find((i) => i.kind === 'front');
  if (front) field_sources.front_image = front.source;
  const offers = dedupeOffers(records.map((r) => r.price).filter((o): o is PriceOffer => !!o)).sort(
    (a, b) => rankOf(p.price, a.source) - rankOf(p.price, b.source),
  );
  if (offers[0]) field_sources.price = offers[0].source;

  const merged: MergedEdition = {
    key: '',
    title: take('title', (r) => r.title, p.title) ?? records[0]!.title,
    subtitle: take('subtitle', (r) => r.subtitle, p.title),
    isbn_10: isbn10,
    isbn_13: isbn13,
    publisher: take('publisher', (r) => r.publisher, p.publisher),
    publication_year: take('publication_year', (r) => r.publication_year, p.publication_year),
    language: take('language', (r) => r.language, p.language),
    page_count: take('page_count', (r) => r.page_count, p.page_count),
    format: take('format', (r) => r.format, p.format),
    edition_name: take('edition_name', (r) => r.edition_name, p.edition_name),
    identifiers: {
      google_books_id: records.find((r) => r.identifiers.google_books_id)?.identifiers.google_books_id ?? null,
      open_library_edition_id: records.find((r) => r.identifiers.open_library_edition_id)?.identifiers.open_library_edition_id ?? null,
      asin: records.find((r) => r.identifiers.asin)?.identifiers.asin ?? null,
    },
    images: uniqImages,
    offers,
    sources: [...new Set(records.map((r) => r.source))],
    source_urls: [...new Set(records.map((r) => r.source_url).filter((u): u is string => !!u))],
    field_sources,
    conflicts,
    record_refs: records.map((r) => recordRef(r)),
  };
  merged.key = editionKeyOf(merged);
  return merged;
}

export function recordRef(r: SourceRecord): string {
  return `${r.source}:${r.record_type}:${r.source_id}`;
}
