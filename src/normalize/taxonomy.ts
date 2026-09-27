import type { TaxonomyConfig } from '../config/index.js';
import { slugify } from '../lib/text.js';

export interface Classification {
  category: string | null;
  subcategory: string | null;
}

export interface CategoryHint {
  category: string | null;
  subcategory: string | null;
}

/**
 * Chooses one (category, subcategory) from the controlled taxonomy using the
 * genre scores. Discovery hints only break ties between already-supported
 * subcategories; they never create a classification by themselves.
 */
export class Taxonomy {
  private readonly subIndex: Array<{ category: string; subcategory: string; genres: string[]; priority: number }> = [];
  private readonly categories = new Map<string, Set<string>>();

  constructor(private readonly cfg: TaxonomyConfig) {
    for (const c of cfg.categories) {
      this.categories.set(c.name, new Set(c.subcategories.map((s) => s.name)));
      for (const s of c.subcategories) {
        this.subIndex.push({ category: c.name, subcategory: s.name, genres: s.genres, priority: s.priority ?? 0 });
      }
    }
  }

  isValid(category: string | null, subcategory: string | null): boolean {
    if (category === null) return subcategory === null;
    const subs = this.categories.get(category);
    if (!subs) return false;
    return subcategory === null || subs.has(subcategory);
  }

  categoryNames(): string[] {
    return [...this.categories.keys()];
  }

  /** Resolve a category by exact name or slug ("business-economics"). */
  resolveCategory(nameOrSlug: string): string | null {
    for (const name of this.categories.keys()) {
      if (name.toLowerCase() === nameOrSlug.toLowerCase() || slugify(name) === slugify(nameOrSlug)) return name;
    }
    return null;
  }

  resolveSubcategory(nameOrSlug: string): { category: string; subcategory: string } | null {
    const hit = this.subIndex.find(
      (s) => s.subcategory.toLowerCase() === nameOrSlug.toLowerCase() || slugify(s.subcategory) === slugify(nameOrSlug),
    );
    return hit ? { category: hit.category, subcategory: hit.subcategory } : null;
  }

  tree(): Array<{ name: string; slug: string; subcategories: Array<{ name: string; slug: string; genres: string[] }> }> {
    return this.cfg.categories.map((c) => ({
      name: c.name,
      slug: slugify(c.name),
      subcategories: c.subcategories.map((s) => ({ name: s.name, slug: slugify(s.name), genres: s.genres })),
    }));
  }

  classify(genreScores: Record<string, number>, acceptedGenres: string[], hints: CategoryHint[] = []): Classification {
    const accepted = new Set(acceptedGenres);
    let best: { category: string; subcategory: string; score: number } | null = null;
    for (const s of this.subIndex) {
      const supporting = s.genres.filter((g) => accepted.has(g));
      if (supporting.length === 0) continue;
      const genreScore = Math.max(...supporting.map((g) => genreScores[g] ?? 0));
      const hinted = hints.some((h) => h.category === s.category && h.subcategory === s.subcategory);
      const score = genreScore + s.priority * 0.15 + (hinted ? 0.25 : 0);
      if (!best || score > best.score) best = { category: s.category, subcategory: s.subcategory, score };
    }
    if (best) return { category: best.category, subcategory: best.subcategory };
    for (const [genre, category] of Object.entries(this.cfg.fallback_categories)) {
      if (accepted.has(genre)) return { category, subcategory: null };
    }
    return { category: null, subcategory: null };
  }
}
