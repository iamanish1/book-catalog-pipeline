import type { EditionSourceRecord, SourceRecord, WorkSourceRecord } from '../domain/types.js';
import { authorKey, titleKey, trigramSimilarity } from '../lib/text.js';

/**
 * Deduplication + edition matching.
 *
 * 1. Edition identity (strongest first): ISBN-13 → ISBN-10 → Open Library edition
 *    id → Google Books id → ASIN. Records sharing a key are the same edition,
 *    unless they carry different ISBN-13s (never merged — different products).
 * 2. Work grouping:
 *    a. editions carrying an Open Library work id join that work;
 *    b. editions whose ISBN-13 is listed by exactly one known work join it;
 *    c. otherwise, exact normalized title + overlapping author keys (strong
 *       evidence) joins an existing work;
 *    d. fuzzy similarity only produces *duplicate candidates* for review.
 */

export interface WorkGroup {
  key: string;
  workRecords: WorkSourceRecord[];
  editionClusters: EditionSourceRecord[][];
  duplicateCandidates: Array<{ other_key: string; other_title: string; similarity: number; reason: string }>;
  notes: string[];
}

export interface DedupeStats {
  input_records: number;
  work_records: number;
  edition_records: number;
  edition_clusters: number;
  edition_duplicates_merged: number;
  works: number;
  work_duplicates_merged: number;
  identity_conflicts: number;
  fuzzy_candidates: number;
}

class UnionFind {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

function identityKeys(r: EditionSourceRecord): string[] {
  const keys: string[] = [];
  if (r.isbn_13) keys.push(`isbn13:${r.isbn_13}`);
  if (r.isbn_10) keys.push(`isbn10:${r.isbn_10}`);
  if (r.identifiers.open_library_edition_id) keys.push(`oled:${r.identifiers.open_library_edition_id}`);
  if (r.identifiers.google_books_id) keys.push(`gb:${r.identifiers.google_books_id}`);
  if (r.identifiers.asin) keys.push(`asin:${r.identifiers.asin}`);
  return keys;
}

export function authorKeys(authors: string[]): Set<string> {
  return new Set(authors.map(authorKey).filter(Boolean));
}

/** Strong author evidence: both sides have authors and the smaller set is contained in the larger. */
export function authorsCompatible(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const k of small) if (!large.has(k)) return false;
  return true;
}

export function clusterEditions(editions: EditionSourceRecord[]): { clusters: EditionSourceRecord[][]; conflicts: string[] } {
  const uf = new UnionFind(editions.length);
  const isbnOf = new Map<number, Set<string>>(); // root -> isbn13 set
  editions.forEach((e, i) => isbnOf.set(i, new Set(e.isbn_13 ? [e.isbn_13] : [])));
  const conflicts: string[] = [];
  const firstByKey = new Map<string, number>();
  for (let i = 0; i < editions.length; i++) {
    for (const key of identityKeys(editions[i]!)) {
      const j = firstByKey.get(key);
      if (j === undefined) {
        firstByKey.set(key, i);
        continue;
      }
      const ri = uf.find(i);
      const rj = uf.find(j);
      if (ri === rj) continue;
      const a = isbnOf.get(ri)!;
      const b = isbnOf.get(rj)!;
      if (a.size && b.size && ![...a].every((x) => b.has(x))) {
        conflicts.push(`identity_conflict:${key}:${[...a].join('|')}≠${[...b].join('|')}`);
        continue;
      }
      uf.union(rj, ri);
      const root = uf.find(ri);
      isbnOf.set(root, new Set([...a, ...b]));
    }
  }
  const groups = new Map<number, EditionSourceRecord[]>();
  editions.forEach((e, i) => {
    const r = uf.find(i);
    groups.set(r, [...(groups.get(r) ?? []), e]);
  });
  return { clusters: [...groups.values()], conflicts };
}

interface Node {
  key: string;
  title: string;
  titleKey: string;
  authors: Set<string>;
  olWorkIds: Set<string>;
  workRecords: WorkSourceRecord[];
  editionClusters: EditionSourceRecord[][];
  candidates: WorkGroup['duplicateCandidates'];
  notes: string[];
}

function clusterTitle(c: EditionSourceRecord[]): string {
  return c[0]!.title;
}

export function dedupe(records: SourceRecord[]): { groups: WorkGroup[]; stats: DedupeStats } {
  const works = records.filter((r): r is WorkSourceRecord => r.record_type === 'work');
  const editions = records.filter((r): r is EditionSourceRecord => r.record_type === 'edition');
  const stats: DedupeStats = {
    input_records: records.length,
    work_records: works.length,
    edition_records: editions.length,
    edition_clusters: 0,
    edition_duplicates_merged: 0,
    works: 0,
    work_duplicates_merged: 0,
    identity_conflicts: 0,
    fuzzy_candidates: 0,
  };

  // --- Work nodes from work records (same OL work id → same node).
  const nodes: Node[] = [];
  const byOlWork = new Map<string, Node>();
  for (const w of works) {
    const id = w.identifiers.open_library_work_id!;
    let n = byOlWork.get(id);
    if (!n) {
      n = { key: `olw:${id}`, title: w.title, titleKey: titleKey(w.title), authors: authorKeys(w.authors), olWorkIds: new Set([id]), workRecords: [], editionClusters: [], candidates: [], notes: [] };
      byOlWork.set(id, n);
      nodes.push(n);
    } else stats.work_duplicates_merged++;
    n.workRecords.push(w);
    for (const a of authorKeys(w.authors)) n.authors.add(a);
  }
  const isbnClaims = new Map<string, Set<Node>>();
  for (const n of nodes) for (const w of n.workRecords) for (const i of w.known_isbn13s) {
    const s = isbnClaims.get(i) ?? new Set<Node>();
    s.add(n);
    isbnClaims.set(i, s);
  }

  // --- Edition clusters.
  const { clusters, conflicts } = clusterEditions(editions);
  stats.edition_clusters = clusters.length;
  stats.edition_duplicates_merged = editions.length - clusters.length;
  stats.identity_conflicts = conflicts.length;

  const mergeNodes = (into: Node, from: Node, why: string) => {
    if (into === from) return;
    into.workRecords.push(...from.workRecords);
    into.editionClusters.push(...from.editionClusters);
    for (const a of from.authors) into.authors.add(a);
    for (const id of from.olWorkIds) {
      into.olWorkIds.add(id);
      byOlWork.set(id, into);
    }
    into.notes.push(`merged ${from.key} (${why})`);
    nodes.splice(nodes.indexOf(from), 1);
    stats.work_duplicates_merged++;
  };

  const unattached: EditionSourceRecord[][] = [];
  for (const c of clusters) {
    const olIds = [...new Set(c.map((e) => e.identifiers.open_library_work_id).filter((x): x is string => !!x))];
    const linked = olIds.map((id) => byOlWork.get(id)).filter((n): n is Node => !!n);
    if (linked.length > 0) {
      const target = linked[0]!;
      target.editionClusters.push(c);
      // Same ISBN listed under two OL works → the works are duplicates if titles agree.
      for (const other of linked.slice(1)) {
        if (other === target) continue;
        if (trigramSimilarity(other.titleKey, target.titleKey) >= 0.8) mergeNodes(target, other, `shared edition ${c[0]!.isbn_13 ?? ''}`);
        else target.notes.push(`edition ${c[0]!.isbn_13 ?? ''} also linked to ${other.key} with a different title; not merged`);
      }
      continue;
    }
    // ISBN claimed by a known work.
    const isbn = c.find((e) => e.isbn_13)?.isbn_13;
    const claims = isbn ? [...(isbnClaims.get(isbn) ?? [])].filter((n) => nodes.includes(n)) : [];
    if (claims.length >= 1) {
      const ck = titleKey(clusterTitle(c));
      const best = claims.sort((a, b) => trigramSimilarity(b.titleKey, ck) - trigramSimilarity(a.titleKey, ck))[0]!;
      best.editionClusters.push(c);
      continue;
    }
    unattached.push(c);
  }

  // --- Exact title + author evidence, then fuzzy candidates.
  const byTitle = new Map<string, Node[]>();
  const index = (n: Node) => byTitle.set(n.titleKey, [...(byTitle.get(n.titleKey) ?? []), n]);
  nodes.forEach(index);
  for (const c of unattached) {
    const title = clusterTitle(c);
    const tk = titleKey(title);
    const ak = authorKeys(c.flatMap((e) => e.authors));
    const exact = (byTitle.get(tk) ?? []).find((n) => authorsCompatible(n.authors, ak));
    if (exact && tk.length >= 2) {
      exact.editionClusters.push(c);
      for (const a of ak) exact.authors.add(a);
      continue;
    }
    const n: Node = {
      key: `ed:${c[0]!.isbn_13 ?? c[0]!.identifiers.google_books_id ?? c[0]!.identifiers.asin ?? c[0]!.source_id}`,
      title,
      titleKey: tk,
      authors: ak,
      olWorkIds: new Set(),
      workRecords: [],
      editionClusters: [c],
      candidates: [],
      notes: [],
    };
    nodes.push(n);
    index(n);
  }

  // Fuzzy candidate generation (blocked by shared author key). Never merges.
  const byAuthor = new Map<string, Node[]>();
  for (const n of nodes) for (const a of n.authors) byAuthor.set(a, [...(byAuthor.get(a) ?? []), n]);
  const seenPairs = new Set<string>();
  for (const block of byAuthor.values()) {
    if (block.length < 2 || block.length > 200) continue;
    for (let i = 0; i < block.length; i++) {
      for (let j = i + 1; j < block.length; j++) {
        const a = block[i]!;
        const b = block[j]!;
        const pair = [a.key, b.key].sort().join('~');
        if (seenPairs.has(pair)) continue;
        seenPairs.add(pair);
        const sim = trigramSimilarity(a.titleKey, b.titleKey);
        const exactTitle = a.titleKey === b.titleKey;
        if (!exactTitle && sim < 0.75) continue;
        const reason = exactTitle ? 'same normalized title and author, different source work ids' : 'similar title, shared author';
        const similarity = exactTitle ? 0.95 : Math.round(sim * 0.9 * 1000) / 1000;
        a.candidates.push({ other_key: b.key, other_title: b.title, similarity, reason });
        b.candidates.push({ other_key: a.key, other_title: a.title, similarity, reason });
        stats.fuzzy_candidates++;
      }
    }
  }

  stats.works = nodes.length;
  const groups: WorkGroup[] = nodes.map((n) => ({
    key: n.key,
    workRecords: n.workRecords,
    editionClusters: n.editionClusters,
    duplicateCandidates: n.candidates,
    notes: [...n.notes, ...conflicts.filter((c) => n.editionClusters.some((cl) => cl.some((e) => e.isbn_13 && c.includes(e.isbn_13))))],
  }));
  return { groups, stats };
}
