import type { EditionFormat } from '../domain/types.js';

const RULES: Array<[RegExp, EditionFormat]> = [
  [/mass\s*market/i, 'Mass Market Paperback'],
  [/paper\s*back|softcover|soft\s*cover|trade\s*paper|\bpbk\b/i, 'Paperback'],
  [/hard\s*(cover|back|bound)|\bhbk\b|\bcloth\b/i, 'Hardcover'],
  [/board\s*book/i, 'Board Book'],
  [/library\s*binding/i, 'Library Binding'],
  [/spiral/i, 'Spiral-bound'],
  [/e-?book|kindle|electronic|epub|digital/i, 'eBook'],
  [/audio|\bcd\b|mp3|audible/i, 'Audiobook'],
];

/** Normalize a free-text binding/format ("paperback", "Mass Market Paperback", "Kindle Edition"). */
export function normalizeFormat(raw: string | null | undefined): EditionFormat | null {
  if (!raw) return null;
  for (const [re, f] of RULES) if (re.test(raw)) return f;
  return null;
}
