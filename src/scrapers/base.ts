import type { HttpClient, HttpResult } from '../lib/http.js';
import { log } from '../lib/logger.js';
import type { RobotsPolicy } from './robots.js';
import { ALLOW_ALL, DENY_ALL, parseRobots, policyFromRules } from './robots.js';

export class ScrapeNotPermittedError extends Error {
  constructor(readonly url: string, reason: string) {
    super(`Not permitted to fetch ${url}: ${reason}`);
    this.name = 'ScrapeNotPermittedError';
  }
}

/**
 * Base adapter for permitted HTML sources. Keeps scraping mechanics out of
 * business logic and enforces: explicit terms review, robots.txt, and polite
 * throttling (site minimum delay or Crawl-delay, whichever is larger).
 * It never uses stealth techniques, proxies, CAPTCHA solving or logins.
 */
export class ScraperAdapter {
  private readonly robots = new Map<string, RobotsPolicy>();

  constructor(
    readonly name: string,
    private readonly http: HttpClient,
    private readonly userAgent: string,
    private readonly opts: { termsReviewed: boolean; minDelayMs: number },
  ) {}

  private async policyFor(origin: string): Promise<RobotsPolicy> {
    const hit = this.robots.get(origin);
    if (hit) return hit;
    let policy: RobotsPolicy;
    try {
      const res = await this.http.getText(`${origin}/robots.txt`, {
        source: `scraper_${this.name}`,
        kind: 'robots',
        cacheClass: 'metadata',
        acceptStatuses: [401, 403, 404, 410],
        headers: { Accept: 'text/plain' },
      });
      if (res.status === 200) policy = policyFromRules(parseRobots(res.body, this.userAgent));
      else if (res.status === 404 || res.status === 410) policy = ALLOW_ALL;
      else policy = DENY_ALL; // 401/403: treat an access-controlled robots.txt as "do not crawl"
    } catch (e) {
      log.warn('robots.txt unavailable; treating site as disallowed', { origin, error: String(e) });
      policy = DENY_ALL;
    }
    this.robots.set(origin, policy);
    return policy;
  }

  async fetchPage(url: string): Promise<HttpResult<string>> {
    if (!this.opts.termsReviewed) throw new ScrapeNotPermittedError(url, 'site terms have not been reviewed (terms_reviewed=false)');
    const u = new URL(url);
    const policy = await this.policyFor(u.origin);
    if (!policy.isAllowed(u.pathname + u.search)) throw new ScrapeNotPermittedError(url, 'disallowed by robots.txt');
    const delay = Math.max(this.opts.minDelayMs, policy.crawlDelayMs ?? 0);
    const interval = this.http.throttle.intervalFor(u.host);
    if (delay > interval) await new Promise((r) => setTimeout(r, delay - interval));
    return this.http.getText(url, {
      source: `scraper_${this.name}`,
      kind: 'page',
      cacheClass: 'metadata',
      headers: { Accept: 'text/html' },
    });
  }
}
