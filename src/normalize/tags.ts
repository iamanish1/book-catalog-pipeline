import type { TagsConfig } from '../config/index.js';
import { foldText } from '../lib/text.js';

const GENERIC_GENRES = new Set(['fiction', 'non fiction']);
// Common non-English morphology in subject headings (Spanish/Portuguese/French/Italian/German/Dutch).
const FOREIGN_SUFFIX = /(?:cion|ciones|dade|dades|idad|idades|ungen|heit|keit|zione|zioni|ssements|mente|mentos|privada|privadas|ingen|elles)$/;

/**
 * Builds lowercase, deduplicated, concise, searchable tags from real metadata
 * (genres, subcategory, source subject headings). Cataloguing noise, list
 * markers and non-English subject headings are filtered out.
 */
export class TagGenerator {
  private readonly stop: Set<string>;
  private readonly rewrite: Map<string, string>;
  private readonly foreign: Set<string>;

  constructor(private readonly cfg: TagsConfig) {
    this.stop = new Set(cfg.stop_phrases.map((s) => foldText(s)));
    this.rewrite = new Map(Object.entries(cfg.rewrite).map(([k, v]) => [foldText(k), foldText(v)]));
    this.foreign = new Set((cfg.foreign_markers ?? []).map((s) => foldText(s)));
  }

  /** Normalize a controlled genre/subcategory name into a tag. */
  genreTag(name: string): string | null {
    const t = foldText(name);
    return t && !GENERIC_GENRES.has(t) ? t : null;
  }

  /** Normalize a free-text subject heading into a tag, or null if it has no search value. */
  subjectTag(raw: string): string | null {
    const series = raw.match(/^series:(.+)$/i);
    if (series) return this.subjectTag(series[1]!.replace(/_/g, ' '));
    if (/^[a-z]+:|=|\d{4}-\d{2}-\d{2}/i.test(raw)) return null; // list/typed markers ("nyt:...", "place:...")
    // "Magic -- Fiction" → "magic"; "Wizards / Juvenile fiction" → "wizards".
    let head = raw.split(/\s*(?:--|\/|\()\s*/)[0] ?? raw;
    // Inverted catalogue headings: "Finance, Personal" → "Personal Finance"; "Science fiction, General" → "Science fiction".
    const inv = head.match(/^([^,]+),\s*([^,\s]+)\s*$/);
    if (inv) head = /^general$/i.test(inv[2]!) ? inv[1]! : `${inv[2]} ${inv[1]}`;
    let t = foldText(head);
    t = this.rewrite.get(t) ?? t;
    if (!t || t.length < this.cfg.min_length) return null;
    if (this.stop.has(t)) return null;
    const words = t.split(' ');
    if (words.length > this.cfg.max_words) return null;
    if (words[0] === 'fiction' || words[0] === 'juvenile') return null; // BISAC-style "Fiction, fantasy, epic"
    if (words.some((w) => this.foreign.has(w) || FOREIGN_SUFFIX.test(w))) return null;
    if (words[words.length - 1] === 'general') return null;
    if (/^\d+$/.test(t)) return null;
    if (/\b(fictitious character|imaginary place|imaginary organization|protected|accessible|in library|reading level)\b/.test(t)) return null;
    return t;
  }

  generate(input: { genres: string[]; subcategory: string | null; subjects: string[]; language: string | null }): string[] {
    const out: string[] = [];
    const push = (t: string | null) => {
      if (t && !out.includes(t) && out.length < this.cfg.max_tags) out.push(t);
    };
    for (const g of input.genres) push(this.genreTag(g));
    if (input.subcategory) push(this.genreTag(input.subcategory));
    // Subjects: prefer ones repeated across records/sources, then first-seen order.
    const counts = new Map<string, number>();
    const order: string[] = [];
    for (const s of input.subjects) {
      const t = this.subjectTag(s);
      if (!t) continue;
      if (!counts.has(t)) order.push(t);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const ranked = order.map((t, i) => ({ t, i, c: counts.get(t)! })).sort((a, b) => b.c - a.c || a.i - b.i);
    for (const { t } of ranked) push(t);
    return out;
  }
}
