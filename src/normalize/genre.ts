import type { GenreDef, TaxonomyConfig } from '../config/index.js';
import type { GenreEvidence, SourceName } from '../domain/types.js';
import { foldText } from '../lib/text.js';

export interface RawGenreInput {
  raw: string;
  source: SourceName | 'discovery_hint';
}

interface CompiledGenre {
  name: string;
  strong: string[];
  weak: string[];
  exclude: string[];
  implies: string[];
}

export interface GenreResult {
  genres: string[];
  scores: Record<string, number>;
  evidence: GenreEvidence[];
}

const fold = (s: string) => ` ${foldText(s)} `;

/**
 * Maps raw source categories/subjects ("Fiction / Fantasy / Epic",
 * "Fantasy fiction", "Magic -- Fiction") to controlled genre names, using
 * weighted evidence so a single noisy term from a single source cannot assign a genre.
 */
export class GenreNormalizer {
  private readonly genres: CompiledGenre[];
  private readonly byName = new Map<string, CompiledGenre>();

  constructor(private readonly taxonomy: TaxonomyConfig) {
    this.genres = taxonomy.genres.map((g: GenreDef) => ({
      name: g.name,
      strong: g.aliases.map(fold),
      weak: (g.weak ?? []).map(fold),
      exclude: (g.exclude ?? []).map(fold),
      implies: g.implies ?? [],
    }));
    for (const g of this.genres) this.byName.set(g.name, g);
  }

  isGenre(name: string): boolean {
    return this.byName.has(name);
  }

  /** Split hierarchical raw strings ("Fiction / Fantasy / Epic") into candidate terms. */
  static explode(raw: string): string[] {
    const parts = raw.split(/\s*(?:\/|--|>|\|)\s*/).map((p) => p.trim()).filter(Boolean);
    const out = new Set<string>([raw.trim()]);
    for (const p of parts) out.add(p);
    // Also consider "parent child" pairs ("Fiction / Fantasy" -> "fiction fantasy").
    for (let i = 0; i + 1 < parts.length; i++) out.add(`${parts[i]} ${parts[i + 1]}`);
    return [...out];
  }

  /** Match one raw term. Returns [genre, strength] pairs (1 strong, 0.5 weak). */
  matchTerm(raw: string): Array<[string, number]> {
    const hits = new Map<string, number>();
    for (const term of GenreNormalizer.explode(raw)) {
      const t = fold(term);
      if (t.trim() === '') continue;
      for (const g of this.genres) {
        if (g.exclude.some((e) => t.includes(e))) continue;
        let strength = 0;
        if (g.strong.some((a) => t.includes(a))) strength = 1;
        else if (g.weak.some((a) => t.includes(a))) strength = 0.5;
        if (strength > (hits.get(g.name) ?? 0)) hits.set(g.name, strength);
      }
    }
    return [...hits];
  }

  /** Map a single raw value for display/audit: {raw, normalized[]}. */
  mapRaw(raw: string): { raw: string; normalized: string[] } {
    return { raw, normalized: this.matchTerm(raw).filter(([, s]) => s >= 1).map(([g]) => g) };
  }

  classify(inputs: RawGenreInput[]): GenreResult {
    const rules = this.taxonomy.genre_rules;
    // genre -> source -> accumulated weight
    const perSource = new Map<string, Map<string, number>>();
    const evidence: GenreEvidence[] = [];
    const seen = new Set<string>();
    for (const input of inputs) {
      const key = `${input.source}|${foldText(input.raw)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const weight = rules.source_weights[input.source] ?? 0.5;
      // A discovery hint names a controlled genre directly.
      const matches: Array<[string, number]> = input.source === 'discovery_hint' && this.byName.has(input.raw) ? [[input.raw, 1]] : this.matchTerm(input.raw);
      for (const [genre, strength] of matches) {
        const m = perSource.get(genre) ?? new Map<string, number>();
        m.set(input.source, (m.get(input.source) ?? 0) + weight * strength);
        perSource.set(genre, m);
        if (input.source !== 'discovery_hint') evidence.push({ raw: input.raw, normalized: genre, source: input.source });
      }
    }
    const scores: Record<string, number> = {};
    for (const [genre, m] of perSource) {
      let total = 0;
      for (const v of m.values()) total += Math.min(v, rules.per_source_cap);
      // Discovery hints alone never assign a genre; they only reinforce source evidence.
      const nonHint = [...m.keys()].some((s) => s !== 'discovery_hint');
      if (nonHint) scores[genre] = round(total);
    }
    // Implied parents (Fantasy ⇒ Fiction) inherit a discounted score.
    for (const [genre, score] of Object.entries({ ...scores })) {
      if (score < rules.accept_threshold) continue;
      for (const parent of this.byName.get(genre)?.implies ?? []) {
        scores[parent] = round(Math.max(scores[parent] ?? 0, score * rules.implied_factor, rules.accept_threshold));
      }
    }
    // A fiction genre and "Non-Fiction" contradict: keep whichever has more support.
    if (scores['Non-Fiction'] !== undefined && scores['Fiction'] !== undefined) {
      if (scores['Fiction'] >= scores['Non-Fiction']) delete scores['Non-Fiction'];
      else delete scores['Fiction'];
    }
    // For a work of fiction, non-fiction subjects (e.g. "Artificial intelligence" on a novel) are topics, not genres.
    const fictionScore = scores['Fiction'] ?? 0;
    if (fictionScore >= rules.accept_threshold) {
      for (const g of rules.nonfiction_genres ?? []) {
        if (scores[g] !== undefined && scores[g]! <= fictionScore * 1.5) delete scores[g];
      }
    }
    const generic = new Set(['Fiction', 'Non-Fiction']);
    const accepted = Object.entries(scores)
      .filter(([, s]) => s >= rules.accept_threshold)
      .sort((a, b) => Number(generic.has(a[0])) - Number(generic.has(b[0])) || b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, rules.max_genres)
      .map(([g]) => g);
    return { genres: accepted, scores, evidence };
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
