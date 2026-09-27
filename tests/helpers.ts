import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppEnv } from '../src/config/env.js';
import { loadConfig } from '../src/config/index.js';
import type { EditionSourceRecord, WorkSourceRecord } from '../src/domain/types.js';
import { HttpClient } from '../src/lib/http.js';
import type { RawEnvelope } from '../src/lib/raw-store.js';
import { RawStore } from '../src/lib/raw-store.js';
import { emptySignals } from '../src/scoring/popularity.js';

export const config = loadConfig(path.resolve('config'));

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fs.readFileSync(path.resolve('tests/fixtures', name), 'utf8')) as T;
}

export function tmpDir(prefix = 'books-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function tmpStore(): RawStore {
  const DAY = 86_400_000;
  return new RawStore(tmpDir(), { metadata: 30 * DAY, price: DAY / 2, image: 30 * DAY });
}

/** Put a response into a raw store as if it had been fetched. Returns the ref. */
export function putRaw(store: RawStore, source: string, kind: string, key: string, body: unknown, status = 200): string {
  const ref = store.refFor(source, kind, key);
  const env: RawEnvelope = {
    source,
    kind,
    cache_class: 'metadata',
    cache_key: key,
    url: `https://example.test/${kind}/${encodeURIComponent(key)}`,
    method: 'GET',
    status,
    fetched_at: '2026-09-27T00:00:00.000Z',
    body,
  };
  store.write(ref, env);
  return ref;
}

export function testEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  const dataDir = tmpDir('books-data-');
  return {
    databaseUrl: ':memory:',
    port: 0,
    nodeEnv: 'test',
    adminApiToken: '',
    googleBooksApiKey: '',
    googleBooksCountry: 'IN',
    openLibraryContactEmail: '',
    openLibraryEditionsPerWork: 8,
    amazon: { accessKey: '', secretKey: '', partnerTag: '', marketplace: 'www.amazon.in', host: 'webservices.amazon.in', region: 'eu-west-1' },
    batchSize: 50,
    requestDelayMs: 0,
    requestTimeoutMs: 2000,
    maxRetries: 2,
    metadataCacheMs: 30 * 86_400_000,
    priceCacheMs: 12 * 3_600_000,
    imageCacheMs: 30 * 86_400_000,
    imageValidation: 'none',
    duplicateQuarantineThreshold: 0.9,
    dataDir,
    logLevel: 'silent',
    ...overrides,
  };
}

export function fakeHttp(store: RawStore, fetchImpl: typeof fetch = async () => new Response('{}', { status: 200 })): HttpClient {
  return new HttpClient({ rawStore: store, userAgent: 'test', defaultDelayMs: 0, timeoutMs: 1000, maxRetries: 2, fetchImpl, sleep: async () => {} });
}

let seq = 0;
const EMPTY_IDS = { google_books_id: null, open_library_work_id: null, open_library_edition_id: null, asin: null };

type EditionInput = Omit<Partial<EditionSourceRecord>, 'identifiers'> & { title: string; identifiers?: Partial<EditionSourceRecord['identifiers']> };

export function edition(p: EditionInput): EditionSourceRecord {
  seq++;
  return {
    record_type: 'edition',
    source: 'google_books',
    source_id: `id${seq}`,
    source_url: `https://example.test/e/${seq}`,
    raw_ref: null,
    retrieved_at: '2026-09-27T00:00:00.000Z',
    subtitle: null,
    authors: [],
    description: null,
    categories_raw: [],
    subjects_raw: [],
    images: [],
    signals: emptySignals(),
    discovery: [],
    warnings: [],
    isbn_10: null,
    isbn_13: null,
    publisher: null,
    publication_year: null,
    first_publication_year: null,
    language: 'en',
    page_count: null,
    format: null,
    edition_name: null,
    price: null,
    ...p,
    identifiers: { ...EMPTY_IDS, ...p.identifiers },
  };
}

export function work(p: Partial<WorkSourceRecord> & { title: string; olWorkId: string }): WorkSourceRecord {
  const { olWorkId, ...rest } = p;
  return {
    record_type: 'work',
    source: 'open_library',
    source_id: olWorkId,
    source_url: `https://openlibrary.org/works/${olWorkId}`,
    raw_ref: null,
    retrieved_at: '2026-09-27T00:00:00.000Z',
    subtitle: null,
    authors: [],
    description: null,
    categories_raw: [],
    subjects_raw: [],
    images: [],
    signals: emptySignals(),
    discovery: [],
    warnings: [],
    first_publication_year: null,
    known_isbn13s: [],
    language: null,
    ...rest,
    identifiers: { google_books_id: null, open_library_work_id: olWorkId, open_library_edition_id: null, asin: null },
  };
}
