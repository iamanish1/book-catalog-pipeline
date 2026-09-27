import type { PopularityConfig } from '../config/index.js';
import type { DiscoveryHit, PopularityResult, PopularitySignals } from '../domain/types.js';

const logNorm = (v: number | null, cap: number) => (v && v > 0 ? Math.min(1, Math.log10(1 + v) / Math.log10(1 + cap)) : 0);

export function emptySignals(): PopularitySignals {
  return {
    average_rating: null,
    ratings_count: null,
    edition_count: null,
    readinglog_count: null,
    bestseller_mentions: null,
    retailer_available: null,
  };
}

/** Per source, keep the strongest observation of each signal (records of the same work repeat work-level signals). */
export function mergeSignalsBySource(records: Array<{ source: string; signals: PopularitySignals }>): Record<string, PopularitySignals> {
  const out: Record<string, PopularitySignals> = {};
  for (const r of records) {
    const cur = (out[r.source] ??= emptySignals());
    const s = r.signals;
    if (s.ratings_count !== null && (cur.ratings_count === null || s.ratings_count > cur.ratings_count)) {
      cur.ratings_count = s.ratings_count;
      cur.average_rating = s.average_rating;
    } else if (cur.average_rating === null && s.average_rating !== null) {
      cur.average_rating = s.average_rating;
    }
    for (const k of ['edition_count', 'readinglog_count', 'bestseller_mentions'] as const) {
      const v = s[k];
      if (v !== null && (cur[k] === null || v > cur[k]!)) cur[k] = v;
    }
    if (s.retailer_available !== null) cur.retailer_available = Boolean(cur.retailer_available) || s.retailer_available;
  }
  return out;
}

/**
 * Internal, configurable popularity score (0–100) built only from observed
 * signals. Returns score=null when no signal at all is available rather than
 * inventing popularity.
 */
export function computePopularity(
  bySource: Record<string, PopularitySignals>,
  discovery: DiscoveryHit[],
  cfg: PopularityConfig,
): PopularityResult {
  const n = cfg.normalization;
  const sources = Object.values(bySource);

  // Ratings from different platforms are different user populations: sum counts, count-weighted mean.
  let ratingsCount = 0;
  let ratingSum = 0;
  let haveRating = false;
  for (const s of sources) {
    if (s.ratings_count && s.ratings_count > 0 && s.average_rating !== null) {
      ratingsCount += s.ratings_count;
      ratingSum += s.average_rating * s.ratings_count;
      haveRating = true;
    }
  }
  const avgRating = haveRating ? ratingSum / ratingsCount : null;
  // Bayesian shrinkage so 5.0 from 2 ratings does not beat 4.3 from 50,000.
  const shrunk = avgRating === null ? null : (avgRating * ratingsCount + n.rating_prior_mean * n.rating_prior_weight) / (ratingsCount + n.rating_prior_weight);

  const editionCount = Math.max(0, ...sources.map((s) => s.edition_count ?? 0));
  const readinglog = Math.max(0, ...sources.map((s) => s.readinglog_count ?? 0));
  const bestseller = Math.max(0, ...sources.map((s) => s.bestseller_mentions ?? 0));
  const retailerKnown = sources.some((s) => s.retailer_available !== null);
  const retailer = sources.some((s) => s.retailer_available) ? 1 : 0;

  const rankSignal = discovery.length
    ? Math.max(...discovery.map((d) => (d.total > 0 ? 1 - (d.rank - 1) / Math.max(d.total, 1) : 0)))
    : 0;

  const components = {
    ratings_count: logNorm(ratingsCount, n.ratings_count_cap),
    average_rating: shrunk === null ? 0 : Math.max(0, Math.min(1, (shrunk - 1) / 4)),
    edition_count: logNorm(editionCount, n.edition_count_cap),
    retailer,
    discovery:
      cfg.discovery_mix.rank * rankSignal +
      cfg.discovery_mix.readinglog * logNorm(readinglog, n.readinglog_cap) +
      cfg.discovery_mix.bestseller * Math.min(1, bestseller / 3),
  };

  const anySignal = haveRating || editionCount > 0 || readinglog > 0 || bestseller > 0 || retailerKnown || discovery.length > 0;
  const w = cfg.weights;
  const score = anySignal
    ? Math.round(
        1000 *
          (components.ratings_count * w.ratings_count +
            components.average_rating * w.average_rating +
            components.edition_count * w.edition_count +
            components.retailer * w.retailer +
            components.discovery * w.discovery),
      ) / 10
    : null;

  return {
    score,
    rating: avgRating === null ? null : Math.round(avgRating * 100) / 100,
    ratings_count: haveRating ? ratingsCount : null,
    popularity_source: 'internal_normalized_score',
    components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
    weights: { ...w },
    raw_signals: bySource,
    formula_version: cfg.version,
  };
}
