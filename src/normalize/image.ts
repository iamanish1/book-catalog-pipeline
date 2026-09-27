import type { ImageRef, SourceName } from '../domain/types.js';
import type { HttpClient } from '../lib/http.js';

export function isHttpUrl(u: unknown): u is string {
  if (typeof u !== 'string') return false;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Upgrade to https where the host supports it and strip cosmetic parameters (Google's page-curl effect). */
export function cleanImageUrl(url: string): string {
  const u = new URL(url);
  if (u.protocol === 'http:' && /(^|\.)(googleapis|google|googleusercontent|openlibrary|archive)\.(com|org)$/.test(u.hostname)) {
    u.protocol = 'https:';
  }
  if (u.hostname.includes('google')) u.searchParams.delete('edge');
  return u.toString();
}

export function openLibraryCoverUrl(coverId: number, size: 'S' | 'M' | 'L' = 'L'): string {
  // default=false makes a missing cover return 404 instead of a placeholder, so validation is meaningful.
  return `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg?default=false`;
}

export function frontImage(url: string | null | undefined, source: SourceName, retrievedAt: string, license: string | null = null): ImageRef | null {
  if (!isHttpUrl(url)) return null;
  return { kind: 'front', url: cleanImageUrl(url), source, license, retrieved_at: retrievedAt, reachable: null };
}

export interface ImageCheck {
  reachable: boolean;
  status: number;
  content_type: string | null;
}

/**
 * HEAD-check an image URL (cached per BOOK_IMAGE_CACHE_DAYS). Only follows the
 * source's normal redirect; never works around access controls.
 */
export async function checkImage(http: HttpClient, url: string): Promise<ImageCheck> {
  const host = new URL(url).hostname;
  const ref = http.rawStore.refFor('images', 'head', url);
  const cached = http.rawStore.getFresh<ImageCheck>(ref, 'image');
  if (cached) return cached.body;
  let result: ImageCheck;
  try {
    const res = await http.request(url, {
      source: host,
      kind: 'image_head',
      cacheClass: 'image',
      method: 'HEAD',
      headers: { Accept: 'image/*' },
      acceptStatuses: [400, 401, 403, 404, 410],
    });
    const ct = res.headers.get('content-type');
    result = { reachable: res.ok && (!ct || ct.startsWith('image/')), status: res.status, content_type: ct };
  } catch (e) {
    result = { reachable: false, status: 0, content_type: String(e).slice(0, 120) };
  }
  http.rawStore.write(ref, {
    source: 'images',
    kind: 'head',
    cache_class: 'image',
    cache_key: url,
    url,
    method: 'HEAD',
    status: result.status,
    fetched_at: new Date().toISOString(),
    body: result,
  });
  return result;
}
