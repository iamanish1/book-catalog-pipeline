import fs from 'node:fs';
import path from 'node:path';
import type { DiscoveryQueryDef } from '../config/index.js';
import type { Runtime } from '../providers/registry.js';
import type { ResolvedDiscoveryQuery } from '../providers/types.js';
import { files } from './context.js';

export interface DiscoverOptions {
  /** Desired number of works in the catalog (drives per-query limits). */
  target?: number;
  /** Restrict to these query ids. */
  queries?: string[];
  /** Restrict to these categories. */
  categories?: string[];
  /** Explicit per-query limit (overrides target-derived limits). */
  perQueryLimit?: number;
  /** Over-fetch factor to absorb cross-query duplicates and quarantined records. */
  overfetch?: number;
}

export interface DiscoveryPlan {
  created_at: string;
  target: number | null;
  overfetch: number;
  providers: Array<{ name: string; enabled: boolean; discovery: boolean; reason: string | null }>;
  queries: ResolvedDiscoveryQuery[];
}

/** DISCOVERY: build a reproducible query plan from config/discovery.json. */
export function discover(rt: Runtime, opts: DiscoverOptions = {}): { plan: DiscoveryPlan; stats: Record<string, number> } {
  const cfg = rt.config.discovery;
  let selected: DiscoveryQueryDef[] = cfg.queries;
  if (opts.queries?.length) selected = selected.filter((q) => opts.queries!.includes(q.id));
  if (opts.categories?.length) {
    const cats = opts.categories.map((c) => c.toLowerCase());
    selected = selected.filter((q) => q.category && cats.includes(q.category.toLowerCase()));
  }
  if (selected.length === 0) throw new Error('Discovery selected no queries; check --queries/--categories');

  const overfetch = opts.overfetch ?? 1.3;
  const target = opts.target ?? null;
  const derived = target ? Math.max(1, Math.ceil((target * overfetch) / selected.length)) : cfg.defaults.per_query_limit;
  const queries: ResolvedDiscoveryQuery[] = selected.map((q) => ({
    ...q,
    limit: opts.perQueryLimit ?? Math.min(q.limit ?? cfg.defaults.per_query_limit, derived),
    open_library: { ...cfg.defaults.open_library, ...q.open_library },
    google_books: { ...cfg.defaults.google_books, ...q.google_books },
  }));

  const plan: DiscoveryPlan = {
    created_at: new Date().toISOString(),
    target,
    overfetch,
    providers: rt.providers.map((p) => ({ name: p.name, enabled: p.isEnabled(), discovery: typeof p.discover === 'function', reason: p.disabledReason() })),
    queries,
  };
  const file = files(rt).plan;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  return {
    plan,
    stats: {
      queries: queries.length,
      per_query_limit: queries[0]?.limit ?? 0,
      planned_items_per_provider: queries.reduce((s, q) => s + q.limit, 0),
      enabled_providers: plan.providers.filter((p) => p.enabled).length,
    },
  };
}
