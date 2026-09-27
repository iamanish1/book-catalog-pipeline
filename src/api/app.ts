import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import type { CatalogRepository, ListFilters } from '../db/repository.js';
import { toIsbn13 } from '../lib/isbn.js';
import { log } from '../lib/logger.js';
import { Taxonomy } from '../normalize/taxonomy.js';
import { newJobId } from '../pipeline/context.js';
import { importIsbn, runSync } from '../pipeline/sync.js';
import type { Runtime } from '../providers/registry.js';

export const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function intParam(v: unknown, name: string, def: number, min: number, max: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpProblem(400, `${name} must be an integer between ${min} and ${max}`);
  return n;
}

export function pagination(q: Request['query']): { page: number; limit: number } {
  return {
    page: intParam(q.page, 'page', 1, 1, 100_000),
    limit: intParam(q.limit, 'limit', DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
  };
}

function filters(q: Request['query']): ListFilters {
  const s = (k: string) => (typeof q[k] === 'string' && q[k] !== '' ? String(q[k]) : undefined);
  const sort = s('sort');
  if (sort && !['popularity', 'title', 'year', 'recent'].includes(sort)) throw new HttpProblem(400, 'sort must be popularity|title|year|recent');
  return {
    category: s('category'),
    subcategory: s('subcategory'),
    genre: s('genre'),
    tag: s('tag'),
    language: s('language'),
    author: s('author'),
    publisher: s('publisher'),
    yearFrom: s('year_from') ? intParam(q.year_from, 'year_from', 0, 0, 3000) : undefined,
    yearTo: s('year_to') ? intParam(q.year_to, 'year_to', 3000, 0, 3000) : undefined,
    hasPrice: s('has_price') === 'true' ? true : undefined,
    sort: sort as ListFilters['sort'],
  };
}

export interface AppDeps {
  rt: Runtime;
  repo: CatalogRepository;
}

export function createApp({ rt, repo }: AppDeps): express.Express {
  const app = express();
  const taxonomy = new Taxonomy(rt.config.taxonomy);
  let runningSync: string | null = null;

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  /** Internal endpoints: bearer token when ADMIN_API_TOKEN is set; open only outside production otherwise. */
  const requireAdmin = (req: Request, _res: Response, next: NextFunction) => {
    const token = rt.env.adminApiToken;
    if (!token) {
      if (rt.env.nodeEnv === 'production') return next(new HttpProblem(503, 'ADMIN_API_TOKEN must be configured in production'));
      return next();
    }
    if (req.get('authorization') !== `Bearer ${token}`) return next(new HttpProblem(401, 'invalid or missing bearer token'));
    next();
  };

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', providers: rt.providers.map((p) => ({ name: p.name, enabled: p.isEnabled(), reason: p.disabledReason() })) });
  });

  /* ------------------------------ public reads ------------------------------ */

  app.get('/api/books', (req, res) => {
    const { page, limit } = pagination(req.query);
    res.json(repo.listBooks(filters(req.query), page, limit));
  });

  app.get('/api/books/search', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) throw new HttpProblem(400, 'q is required');
    if (q.length > 200) throw new HttpProblem(400, 'q is too long');
    const { page, limit } = pagination(req.query);
    res.json({ query: q, ...repo.search(q, page, limit, filters(req.query)) });
  });

  app.get('/api/books/popular', (req, res) => {
    const { page, limit } = pagination(req.query);
    res.json({
      popularity_note: 'Ranked by an internal normalized score derived from source signals; not an industry ranking.',
      ...repo.listBooks({ ...filters(req.query), sort: 'popularity' }, page, limit),
    });
  });

  app.get('/api/books/isbn/:isbn', (req, res) => {
    const isbn = toIsbn13(req.params.isbn);
    if (!isbn) throw new HttpProblem(400, 'invalid ISBN');
    const book = repo.getBookByIsbn(isbn);
    if (!book) throw new HttpProblem(404, 'no edition with this ISBN');
    res.json(book);
  });

  app.get('/api/books/category/:category', (req, res) => {
    const { page, limit } = pagination(req.query);
    const cat = taxonomy.resolveCategory(req.params.category);
    const sub = cat ? null : taxonomy.resolveSubcategory(req.params.category);
    if (!cat && !sub) throw new HttpProblem(404, `unknown category "${req.params.category}"`);
    const f = { ...filters(req.query), ...(cat ? { category: cat } : { category: sub!.category, subcategory: sub!.subcategory }) };
    res.json({ category: cat ?? sub!.category, subcategory: sub?.subcategory ?? null, ...repo.listBooks(f, page, limit) });
  });

  app.get('/api/books/genre/:genre', (req, res) => {
    const { page, limit } = pagination(req.query);
    const g = rt.config.taxonomy.genres.find((x) => x.name.toLowerCase() === req.params.genre.toLowerCase() || slug(x.name) === slug(req.params.genre));
    if (!g) throw new HttpProblem(404, `unknown genre "${req.params.genre}"`);
    res.json({ genre: g.name, ...repo.listBooks({ ...filters(req.query), genre: g.name }, page, limit) });
  });

  app.get('/api/books/:id/editions', (req, res) => {
    const { page, limit } = pagination(req.query);
    const eds = repo.listEditions(req.params.id, page, limit);
    if (!eds) throw new HttpProblem(404, 'book not found');
    res.json(eds);
  });

  app.get('/api/books/:id', (req, res) => {
    const book = repo.getBook(req.params.id);
    if (!book) throw new HttpProblem(404, 'book not found');
    res.json(book);
  });

  app.get('/api/categories', (_req, res) => res.json({ items: repo.categoriesWithCounts() }));
  app.get('/api/genres', (_req, res) => res.json({ items: repo.genresWithCounts() }));

  /* ---------------------------- internal: catalog ---------------------------- */

  app.post('/api/catalog/import', requireAdmin, (req, res) => {
    if (runningSync) throw new HttpProblem(409, `an import is already running (job ${runningSync})`);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const target = b.target === undefined ? undefined : intParam(b.target, 'target', 100, 1, 100_000);
    const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
    const jobId = newJobId();
    runningSync = jobId;
    runSync(rt, repo, { target, queries: arr(b.queries), categories: arr(b.categories), offline: b.offline === true }, jobId)
      .catch((e) => log.error('background sync failed', { job_id: jobId, error: String(e) }))
      .finally(() => {
        runningSync = null;
      });
    res.status(202).json({ job_id: jobId, status: 'running', status_url: `/api/catalog/jobs/${jobId}` });
  });

  app.post('/api/catalog/import/isbn', requireAdmin, async (req, res) => {
    const isbn = (req.body as { isbn?: unknown } | undefined)?.isbn;
    if (typeof isbn !== 'string' || !toIsbn13(isbn)) throw new HttpProblem(400, 'body.isbn must be a valid ISBN-10 or ISBN-13');
    const r = await importIsbn(rt, repo, isbn);
    res.status(r.status === 'imported' ? 200 : r.status === 'not_found' ? 404 : 422).json(r);
  });

  app.get('/api/catalog/jobs/:id', requireAdmin, (req, res) => {
    const job = repo.getJob(String(req.params.id));
    if (!job) throw new HttpProblem(404, 'job not found');
    res.json(job);
  });

  /* ----------------------------- internal: admin ----------------------------- */

  app.get('/api/admin/stats', requireAdmin, (_req, res) => {
    res.json({ ...repo.stats(), import_running: runningSync, providers: rt.providers.map((p) => ({ name: p.name, enabled: p.isEnabled(), reason: p.disabledReason() })) });
  });

  app.get('/api/admin/quality-errors', requireAdmin, (req, res) => {
    const { page, limit } = pagination(req.query);
    const sev = req.query.severity === 'error' || req.query.severity === 'warning' ? req.query.severity : undefined;
    res.json(repo.qualityErrors(page, limit, sev));
  });

  app.use('/admin', express.static(path.resolve('public/admin')));

  app.use((_req, _res, next) => next(new HttpProblem(404, 'not found')));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    const status = err instanceof HttpProblem ? err.status : (err as { status?: number }).status ?? 500;
    if (status >= 500) log.error('request failed', { error: String(err) });
    res.status(status).json({ error: status >= 500 && !(err instanceof HttpProblem) ? 'internal error' : (err as Error).message });
  });
  return app;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
