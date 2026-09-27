import type { CatalogConfig } from '../config/index.js';
import type { DiscoveryHit, FieldConflict, MergedEdition, MergedWork, SourceName, SourceRecord } from '../domain/types.js';
import type { WorkGroup } from '../matching/dedupe.js';
import { shortDescription } from '../lib/text.js';
import { computePopularity, emptySignals, mergeSignalsBySource } from '../scoring/popularity.js';
import type { RawGenreInput } from './genre.js';
import { GenreNormalizer } from './genre.js';
import { mergeEdition, pick, rankOf } from './merge.js';
import { TagGenerator } from './tags.js';
import { Taxonomy } from './taxonomy.js';

export interface BuildContext {
  config: CatalogConfig;
  genres: GenreNormalizer;
  taxonomy: Taxonomy;
  tags: TagGenerator;
}

export function buildContext(config: CatalogConfig): BuildContext {
  return {
    config,
    genres: new GenreNormalizer(config.taxonomy),
    taxonomy: new Taxonomy(config.taxonomy),
    tags: new TagGenerator(config.tags),
  };
}

function bestDiscovery(hits: DiscoveryHit[]): DiscoveryHit[] {
  const best = new Map<string, DiscoveryHit>();
  for (const h of hits) {
    const k = `${h.source}|${h.query_id}`;
    const cur = best.get(k);
    if (!cur || h.rank < cur.rank) best.set(k, h);
  }
  return [...best.values()];
}

/** Rank editions so the most commercially complete one is presented first. */
export function editionPresentationScore(e: MergedEdition): number {
  let s = 0;
  if (e.offers.length) s += 4;
  if (e.images.some((i) => i.kind === 'front' && i.reachable !== false)) s += 3;
  if (e.isbn_13) s += 2;
  if (e.publisher) s += 1;
  if (e.format && e.format !== 'eBook') s += 1;
  if (e.page_count) s += 0.5;
  if (e.language === 'en') s += 0.25;
  s += (e.publication_year ?? 1900) / 100000;
  return s;
}

export function buildMergedWork(group: WorkGroup, ctx: BuildContext): MergedWork {
  const cfg = ctx.config.sources;
  const wp = cfg.work_precedence;
  const allEditionRecords = group.editionClusters.flat();
  const all: SourceRecord[] = [...group.workRecords, ...allEditionRecords];
  const field_sources: Record<string, SourceName> = {};
  const conflicts: FieldConflict[] = [];

  const workFirst = <T>(field: string, get: (r: SourceRecord) => T | null | undefined, prec: SourceName[] | undefined) => {
    // Work-level records answer work-level questions first; editions fill gaps.
    let r = pick(field, group.workRecords.map((w) => ({ source: w.source, value: get(w) })), prec);
    if (!r.source) r = pick(field, allEditionRecords.map((e) => ({ source: e.source, value: get(e) })), prec);
    if (r.source) field_sources[field] = r.source;
    if (r.conflict) conflicts.push(r.conflict);
    return r.value;
  };

  const title = workFirst('title', (r) => r.title, wp.title) ?? all[0]!.title;
  const subtitle = workFirst('subtitle', (r) => r.subtitle, wp.title);
  const authors = workFirst('authors', (r) => (r.authors.length ? r.authors : null), wp.authors) ?? [];

  // First publication year: work record, else the earliest edition year (labelled as derived).
  let firstYear = workFirst('first_publication_year', (r) => r.first_publication_year, wp.first_publication_year);
  if (firstYear === null) {
    const years = allEditionRecords.map((e) => e.publication_year).filter((y): y is number => y !== null);
    if (years.length) {
      firstYear = Math.min(...years);
      field_sources.first_publication_year = 'derived:earliest_edition';
    }
  }

  // Description: source precedence across work + edition descriptions.
  const desc = pick(
    'description',
    [...group.workRecords, ...allEditionRecords].map((r) => ({ source: r.source, value: r.description })),
    wp.description,
  );
  if (desc.source) field_sources.description = desc.source;

  // Editions.
  const editions = group.editionClusters.map((c) => mergeEdition(c, cfg)).sort((a, b) => editionPresentationScore(b) - editionPresentationScore(a));

  // Work-only records may carry a cover when no edition has one (OL work covers).
  const workCover = group.workRecords.flatMap((w) => w.images)[0];
  if (workCover && editions.length && !editions.some((e) => e.images.length)) {
    editions[0]!.images.push(workCover);
    editions[0]!.field_sources.front_image = workCover.source;
  }

  // Classification.
  const discovery = bestDiscovery(all.flatMap((r) => r.discovery));
  const genreInputs: RawGenreInput[] = [];
  for (const r of all) {
    for (const c of r.categories_raw) genreInputs.push({ raw: c, source: r.source });
    for (const s of r.subjects_raw) genreInputs.push({ raw: s, source: r.source });
  }
  for (const h of discovery) if (h.genre_hint) genreInputs.push({ raw: h.genre_hint, source: 'discovery_hint' });
  const genreResult = ctx.genres.classify(genreInputs);
  const hints = discovery.map((h) => ({ category: h.category_hint, subcategory: h.subcategory_hint }));
  const cls = ctx.taxonomy.classify(genreResult.scores, genreResult.genres, hints);
  const primaryLang = editions[0]?.language ?? null;
  const tags = ctx.tags.generate({
    genres: genreResult.genres,
    subcategory: cls.subcategory,
    subjects: [...all.flatMap((r) => r.categories_raw), ...all.flatMap((r) => r.subjects_raw)],
    language: primaryLang,
  });

  // Popularity: include retailer availability observed on offers.
  const signalRecords = all.map((r) => ({ source: r.source, signals: r.signals }));
  for (const e of editions) for (const o of e.offers) signalRecords.push({ source: o.source, signals: { ...emptySignals(), retailer_available: true } });
  const popularity = computePopularity(mergeSignalsBySource(signalRecords), discovery, ctx.config.popularity);

  const sources = [...new Set(all.map((r) => r.source))].sort((a, b) => rankOf(wp.title, a) - rankOf(wp.title, b));
  const maxDup = Math.max(0, ...group.duplicateCandidates.map((c) => c.similarity));

  return {
    key: group.key,
    title,
    subtitle,
    authors,
    first_publication_year: firstYear,
    description: desc.value,
    short_description: shortDescription(desc.value),
    genres: genreResult.genres,
    genre_evidence: genreResult.evidence.slice(0, 50),
    category: cls.category,
    subcategory: cls.subcategory,
    tags,
    popularity,
    identifiers: { open_library_work_id: group.workRecords[0]?.identifiers.open_library_work_id ?? null },
    primary_source: field_sources.title ?? sources[0] ?? 'unknown',
    sources,
    source_urls: [...new Set(all.map((r) => r.source_url).filter((u): u is string => !!u))],
    field_sources,
    conflicts,
    editions,
    discovery,
    duplicate_candidates: group.duplicateCandidates,
    duplicate_probability: maxDup,
  };
}
