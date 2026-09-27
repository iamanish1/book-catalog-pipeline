import fs from 'node:fs';
import path from 'node:path';

let loaded = false;

/** Load .env once (Node's built-in loader; no dependency). Existing env vars win. */
export function loadEnv(file = '.env'): void {
  if (loaded) return;
  loaded = true;
  if (process.env.VITEST) return;
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function num(name: string, fallback: number): number {
  const raw = str(name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  return n;
}

export interface AppEnv {
  databaseUrl: string;
  port: number;
  nodeEnv: string;
  adminApiToken: string;
  googleBooksApiKey: string;
  googleBooksCountry: string;
  openLibraryContactEmail: string;
  openLibraryEditionsPerWork: number;
  amazon: { accessKey: string; secretKey: string; partnerTag: string; marketplace: string; host: string; region: string };
  batchSize: number;
  requestDelayMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  metadataCacheMs: number;
  priceCacheMs: number;
  imageCacheMs: number;
  imageValidation: 'primary' | 'all' | 'none';
  duplicateQuarantineThreshold: number;
  dataDir: string;
  logLevel: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function getEnv(): AppEnv {
  loadEnv();
  const imageValidation = str('BOOK_IMAGE_VALIDATION', 'primary');
  if (!['primary', 'all', 'none'].includes(imageValidation)) {
    throw new Error('BOOK_IMAGE_VALIDATION must be one of primary|all|none');
  }
  return {
    databaseUrl: str('DATABASE_URL', 'file:./data/catalog.db'),
    port: num('PORT', 3000),
    nodeEnv: str('NODE_ENV', 'development'),
    adminApiToken: str('ADMIN_API_TOKEN'),
    googleBooksApiKey: str('GOOGLE_BOOKS_API_KEY'),
    googleBooksCountry: str('GOOGLE_BOOKS_COUNTRY', 'IN'),
    openLibraryContactEmail: str('OPEN_LIBRARY_CONTACT_EMAIL'),
    openLibraryEditionsPerWork: num('OPEN_LIBRARY_EDITIONS_PER_WORK', 8),
    amazon: {
      accessKey: str('AMAZON_ACCESS_KEY'),
      secretKey: str('AMAZON_SECRET_KEY'),
      partnerTag: str('AMAZON_PARTNER_TAG'),
      marketplace: str('AMAZON_MARKETPLACE', 'www.amazon.in'),
      host: str('AMAZON_HOST', 'webservices.amazon.in'),
      region: str('AMAZON_REGION', 'eu-west-1'),
    },
    batchSize: num('BOOK_IMPORT_BATCH_SIZE', 100),
    requestDelayMs: num('BOOK_REQUEST_DELAY_MS', 500),
    requestTimeoutMs: num('BOOK_REQUEST_TIMEOUT_MS', 15000),
    maxRetries: num('BOOK_MAX_RETRIES', 4),
    metadataCacheMs: num('BOOK_METADATA_CACHE_DAYS', 30) * DAY,
    priceCacheMs: num('BOOK_PRICE_CACHE_HOURS', 12) * HOUR,
    imageCacheMs: num('BOOK_IMAGE_CACHE_DAYS', 30) * DAY,
    imageValidation: imageValidation as AppEnv['imageValidation'],
    duplicateQuarantineThreshold: num('BOOK_DUPLICATE_QUARANTINE_THRESHOLD', 0.9),
    dataDir: path.resolve(str('BOOK_DATA_DIR', './data')),
    logLevel: str('LOG_LEVEL', 'info'),
  };
}
