/** Text normalization helpers used for matching, cleaning and display. */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Remove diacritics, lowercase, strip punctuation, collapse whitespace. */
export function foldText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Split "Main Title: Subtitle" / "Main Title - Subtitle" into parts. */
export function splitTitle(raw: string): { title: string; subtitle: string | null } {
  const t = collapseWhitespace(decodeEntities(raw));
  const m = t.match(/^(.+?)\s*(?::|\s[-–—]\s)\s*(.+)$/);
  if (m && m[1]!.length >= 2) return { title: m[1]!.trim(), subtitle: m[2]!.trim() };
  return { title: t, subtitle: null };
}

const LEADING_ARTICLES = /^(the|a|an)\s+/;

/**
 * Matching key for a work title: subtitle removed, bracketed series markers
 * removed, case/punctuation/diacritics/leading article folded.
 */
export function titleKey(raw: string): string {
  const { title } = splitTitle(raw);
  const noParen = title.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  return foldText(noParen).replace(LEADING_ARTICLES, '');
}

/** "Rowling, J. K." → "J. K. Rowling"; strips role suffixes; keeps original casing. */
export function normalizeAuthorName(raw: string): string {
  let s = collapseWhitespace(decodeEntities(raw)).replace(/\s*\((?:author|editor|ed\.?|illustrator|translator)\)\s*$/i, '');
  const m = s.match(/^([^,]+),\s*([^,]+)$/);
  if (m && !/^(jr|sr|ii|iii|iv)\.?$/i.test(m[2]!.trim())) s = `${m[2]} ${m[1]}`;
  s = s.replace(/\b([A-Z])\.(?=[A-Z])/g, '$1. ');
  return collapseWhitespace(s);
}

/**
 * Author key: folded surname + first initial. "J.K. Rowling", "Joanne K. Rowling"
 * and "Rowling, J. K." all map to "rowling j".
 */
export function authorKey(raw: string): string {
  const folded = foldText(normalizeAuthorName(raw))
    .replace(/\b(jr|sr|ii|iii|iv|dr|prof|sir|mr|mrs|ms)\b/g, ' ')
    .trim();
  const parts = folded.split(' ').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  return `${parts[parts.length - 1]} ${parts[0]![0]}`;
}

/** Strip HTML/markup and source-specific boilerplate from a description. */
export function cleanDescription(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.replace(/\r\n?/g, '\n');
  s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ');
  s = s.replace(/<\s*(br|\/p|\/div|\/li|p|li)\b[^>]*>/gi, '\n');
  s = s.replace(/<\s*\/?\s*(b|i|em|strong|u|span|a|small|sup|sub)\b[^>]*>/gi, '');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  // Open Library markdown conventions: "([source][1])", link definitions, trailing "----" link blocks.
  s = s.replace(/\(\s*\[source\]\[\d+\]\s*\)/gi, ' ');
  s = s.replace(/^\s*\[\d+\]:\s*\S+.*$/gm, ' ');
  s = s.replace(/\n\s*-{3,}[\s\S]*$/, ' ');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\[([^\]]+)\]\[\d+\]/g, '$1');
  s = s.replace(/(\*{1,3}|_{2,3})([^*_\n]+)\1/g, '$2');
  s = s.replace(/https?:\/\/\S+/g, ' ');
  s = s
    .split('\n')
    .map((l) => collapseWhitespace(l))
    .filter(Boolean)
    .join('\n')
    .trim();
  return s.length >= 20 ? s : null;
}

/** Concise description: whole sentences up to `max` characters. Never invents text. */
export function shortDescription(desc: string | null, max = 300): string | null {
  if (!desc) return null;
  const flat = collapseWhitespace(desc);
  if (flat.length <= max) return flat;
  const sentences = flat.match(/[^.!?]+[.!?]+(?:["”’)]*)(?:\s|$)/g) ?? [];
  let out = '';
  for (const sent of sentences) {
    if ((out + sent).length > max) break;
    out += sent;
  }
  out = out.trim();
  if (out.length >= Math.min(80, max / 2)) return out;
  const cut = flat.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:\s]+$/, '') + '…';
}

export function slugify(s: string): string {
  return foldText(s).replace(/\s+/g, '-');
}

/** Character trigram Jaccard similarity of two folded strings (0..1). */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (s: string) => {
    const p = `  ${s} `;
    const set = new Set<string>();
    for (let i = 0; i < p.length - 2; i++) set.add(p.slice(i, i + 3));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

/** Extract a plausible 4-digit year from free-form date text ("March 2003", "2003-06-21"). */
export function parseYear(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const m = raw.match(/\b(1[4-9]\d\d|20\d\d)\b/);
  return m ? Number(m[1]) : null;
}
