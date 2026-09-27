/** Extracts schema.org Book/Product data from JSON-LD blocks in an HTML page. */
export interface SchemaOrgBook {
  name: string | null;
  authors: string[];
  isbns: string[];
  publisher: string | null;
  datePublished: string | null;
  numberOfPages: number | null;
  bookFormat: string | null;
  inLanguage: string | null;
  image: string | null;
  description: string | null;
  offer: { price: string | number; priceCurrency: string | null; url: string | null } | null;
  genres: string[];
}

type Json = Record<string, unknown>;

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const nameOf = (v: unknown): string | null => str(v) ?? (v && typeof v === 'object' ? str((v as Json).name) : null);

function flatten(node: unknown, out: Json[]): void {
  for (const n of asArray(node)) {
    if (!n || typeof n !== 'object') continue;
    const o = n as Json;
    out.push(o);
    if (o['@graph']) flatten(o['@graph'], out);
    if (o.workExample) flatten(o.workExample, out);
    if (o.mainEntity) flatten(o.mainEntity, out);
  }
}

function hasType(o: Json, t: string): boolean {
  return asArray(o['@type'] as string | string[]).some((x) => typeof x === 'string' && x.toLowerCase() === t.toLowerCase());
}

export function extractJsonLd(html: string): Json[] {
  const nodes: Json[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      flatten(JSON.parse(m[1]!.trim()), nodes);
    } catch {
      /* ignore malformed blocks */
    }
  }
  return nodes;
}

export function extractSchemaOrgBooks(html: string): SchemaOrgBook[] {
  const nodes = extractJsonLd(html).filter((o) => hasType(o, 'Book') || (hasType(o, 'Product') && (o.isbn || o.gtin13)));
  return nodes.map((o) => {
    const offer = asArray(o.offers as Json | Json[])[0];
    const pages = Number(o.numberOfPages);
    return {
      name: str(o.name),
      authors: asArray(o.author as unknown).map(nameOf).filter((a): a is string => !!a),
      isbns: [str(o.isbn), str(o.gtin13), str(o.gtin10)].filter((i): i is string => !!i),
      publisher: nameOf(o.publisher),
      datePublished: str(o.datePublished),
      numberOfPages: Number.isFinite(pages) && pages > 0 ? pages : null,
      bookFormat: str(o.bookFormat)?.replace(/^https?:\/\/schema\.org\//, '') ?? null,
      inLanguage: nameOf(o.inLanguage),
      image: str(o.image) ?? nameOf(asArray(o.image as unknown)[0]) ?? str((asArray(o.image as unknown)[0] as Json | undefined)?.url),
      description: str(o.description),
      offer:
        offer && (typeof offer.price === 'number' || typeof offer.price === 'string')
          ? { price: offer.price as string | number, priceCurrency: str(offer.priceCurrency), url: str(offer.url) }
          : null,
      genres: asArray(o.genre as unknown).map(str).filter((g): g is string => !!g),
    };
  });
}
