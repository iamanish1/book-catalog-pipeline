/** ISBN utilities. Never generates ISBNs; only validates and converts real ones. */

export function cleanIsbn(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

export function isValidIsbn10(raw: string): boolean {
  const s = cleanIsbn(raw);
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = s[i]!;
    sum += (c === 'X' ? 10 : Number(c)) * (10 - i);
  }
  return sum % 11 === 0;
}

export function isValidIsbn13(raw: string): boolean {
  const s = cleanIsbn(raw);
  if (!/^97[89]\d{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

/** Deterministic conversion of a valid ISBN-10 to its ISBN-13 (978 prefix). */
export function isbn10To13(raw: string): string | null {
  const s = cleanIsbn(raw);
  if (!isValidIsbn10(s)) return null;
  const body = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return body + String((10 - (sum % 10)) % 10);
}

/** ISBN-13 → ISBN-10 only exists for the 978 prefix. */
export function isbn13To10(raw: string): string | null {
  const s = cleanIsbn(raw);
  if (!isValidIsbn13(s) || !s.startsWith('978')) return null;
  const body = s.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(body[i]) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  return body + (check === 10 ? 'X' : String(check));
}

export interface ResolvedIsbns {
  isbn_10: string | null;
  isbn_13: string | null;
  /** Raw values that failed checksum/format validation. */
  invalid: string[];
  /** Additional distinct valid ISBN-13s listed on the same record (not used for identity). */
  extra13: string[];
}

/**
 * Resolve raw ISBN strings from a single *edition* into one ISBN-10/13 pair.
 * Invalid values are reported, not silently dropped.
 */
export function resolveIsbns(raw10: string[], raw13: string[]): ResolvedIsbns {
  const invalid: string[] = [];
  const valid13: string[] = [];
  const valid10: string[] = [];
  for (const r of [...raw13, ...raw10]) {
    if (!r) continue;
    const s = cleanIsbn(r);
    if (s.length === 13 && isValidIsbn13(s)) valid13.push(s);
    else if (s.length === 10 && isValidIsbn10(s)) valid10.push(s);
    else invalid.push(r);
  }
  const all13 = [...new Set([...valid13, ...valid10.map((v) => isbn10To13(v)!)])];
  const isbn_13 = all13[0] ?? null;
  let isbn_10 = valid10.find((v) => isbn10To13(v) === isbn_13) ?? null;
  if (!isbn_10 && isbn_13) isbn_10 = isbn13To10(isbn_13);
  return { isbn_10, isbn_13, invalid, extra13: all13.slice(1) };
}

/** Normalize an ISBN from user input to ISBN-13, or null if invalid. */
export function toIsbn13(raw: string): string | null {
  const s = cleanIsbn(raw);
  if (s.length === 13) return isValidIsbn13(s) ? s : null;
  if (s.length === 10) return isbn10To13(s);
  return null;
}

export function looksLikeIsbn(q: string): boolean {
  return toIsbn13(q) !== null;
}
