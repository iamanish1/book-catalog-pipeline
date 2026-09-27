import type { MergedWork, QualityIssue } from '../domain/types.js';
import { isValidCurrency } from '../lib/currency.js';
import { isValidIsbn10, isValidIsbn13 } from '../lib/isbn.js';
import { isHttpUrl } from '../normalize/image.js';
import type { Taxonomy } from '../normalize/taxonomy.js';

export interface ValidationOutcome {
  work: MergedWork;
  issues: QualityIssue[];
  valid: boolean;
}

const MIN_YEAR = 1450; // movable-type printing

function reasonableYear(y: number | null, now: Date): boolean {
  return y === null || (Number.isInteger(y) && y >= MIN_YEAR && y <= now.getUTCFullYear() + 2);
}

/**
 * Validate a merged work. Critical problems (missing title, category outside
 * the taxonomy, nothing identifiable) make it invalid → quarantine. Bad
 * non-critical values (bad year, invalid ISBN, bad URL, negative price,
 * unknown currency, unreachable image) are removed and reported as warnings,
 * so one bad field does not discard an otherwise good record.
 */
export function validateWork(input: MergedWork, taxonomy: Taxonomy, now = new Date()): ValidationOutcome {
  const work: MergedWork = structuredClone(input);
  const issues: QualityIssue[] = [];
  const err = (field: string, code: string, message: string) => issues.push({ field, code, message, severity: 'error' });
  const warn = (field: string, code: string, message: string) => issues.push({ field, code, message, severity: 'warning' });

  if (!work.title || !work.title.trim()) err('title', 'missing_title', 'title is required');
  if (work.authors.length === 0) warn('authors', 'missing_author', 'no author reported by any source');
  if (!reasonableYear(work.first_publication_year, now)) {
    warn('publication_year', 'unreasonable_year', `publication year ${work.first_publication_year} removed`);
    work.first_publication_year = null;
  }
  if (!taxonomy.isValid(work.category, work.subcategory)) {
    err('category', 'invalid_category', `category "${work.category}" / "${work.subcategory}" is not in the taxonomy`);
  }
  if (work.category === null) warn('category', 'unclassified', 'no category could be assigned from source evidence');
  if (work.editions.length === 0 && !work.identifiers.open_library_work_id) {
    err('identifiers', 'no_identity', 'record has neither an edition nor a work identifier');
  }
  if (work.editions.length === 0) warn('editions', 'no_edition', 'no edition with an ISBN is known');
  work.source_urls = work.source_urls.filter((u) => {
    if (isHttpUrl(u)) return true;
    warn('source_urls', 'invalid_url', `removed invalid source url ${u}`);
    return false;
  });

  for (const e of work.editions) {
    const where = `edition:${e.key}`;
    if (e.isbn_13 && !isValidIsbn13(e.isbn_13)) {
      warn(where, 'invalid_isbn13', `invalid ISBN-13 ${e.isbn_13} removed`);
      e.isbn_13 = null;
    }
    if (e.isbn_10 && !isValidIsbn10(e.isbn_10)) {
      warn(where, 'invalid_isbn10', `invalid ISBN-10 ${e.isbn_10} removed`);
      e.isbn_10 = null;
    }
    if (!reasonableYear(e.publication_year, now)) {
      warn(where, 'unreasonable_year', `edition year ${e.publication_year} removed`);
      e.publication_year = null;
    }
    if (e.page_count !== null && (!Number.isInteger(e.page_count) || e.page_count <= 0 || e.page_count > 20000)) {
      warn(where, 'invalid_page_count', `page count ${e.page_count} removed`);
      e.page_count = null;
    }
    e.offers = e.offers.filter((o) => {
      if (!Number.isFinite(o.amount) || o.amount < 0) {
        warn(where, 'invalid_price', `negative/invalid price ${o.amount} from ${o.source} removed`);
        return false;
      }
      if (!isValidCurrency(o.currency)) {
        warn(where, 'invalid_currency', `currency "${o.currency}" from ${o.source} is not ISO-4217; offer removed`);
        return false;
      }
      if (o.buy_url && !isHttpUrl(o.buy_url)) o.buy_url = null;
      return true;
    });
    e.images = e.images.filter((img) => {
      if (!isHttpUrl(img.url)) {
        warn(where, 'invalid_image_url', `invalid image url removed`);
        return false;
      }
      if (img.reachable === false) {
        warn(where, 'unreachable_image', `unreachable image ${img.url} removed`);
        return false;
      }
      return true;
    });
    e.source_urls = e.source_urls.filter(isHttpUrl);
  }
  if (work.editions.length && !work.editions.some((e) => e.images.length)) warn('images', 'missing_image', 'no cover image available');
  if (work.editions.length && !work.editions.some((e) => e.offers.length)) warn('price', 'missing_price', 'no price offer available');

  return { work, issues, valid: !issues.some((i) => i.severity === 'error') };
}

/**
 * Batch-level check: when two works are probable duplicates (fuzzy similarity at
 * or above threshold) but lacked evidence to merge, quarantine the weaker one
 * for human review instead of publishing both.
 */
export function flagProbableDuplicates(outcomes: ValidationOutcome[], threshold: number): void {
  const byKey = new Map(outcomes.map((o) => [o.work.key, o]));
  const strength = (o: ValidationOutcome) => (o.work.popularity.score ?? 0) + o.work.editions.length * 0.01;
  for (const o of outcomes) {
    if (!o.valid) continue;
    for (const c of o.work.duplicate_candidates) {
      if (c.similarity < threshold) continue;
      const other = byKey.get(c.other_key);
      if (!other || !other.valid) continue;
      const loser = strength(o) >= strength(other) ? other : o;
      const winner = loser === o ? other : o;
      loser.valid = false;
      loser.issues.push({
        field: 'duplicate',
        code: 'probable_duplicate',
        message: `probable duplicate of ${winner.work.key} "${winner.work.title}" (similarity ${c.similarity}): ${c.reason}`,
        severity: 'error',
      });
      if (loser === o) break;
    }
  }
}
