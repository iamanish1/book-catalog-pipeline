/**
 * robots.txt parsing and matching (RFC 9309 semantics: most specific group for
 * our user-agent, longest matching rule wins, Allow wins ties, `*` and `$`
 * wildcards). Crawl-delay is honored as a minimum request interval.
 */
export interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelayMs: number | null;
}

export interface RobotsPolicy {
  isAllowed(pathWithQuery: string): boolean;
  crawlDelayMs: number | null;
}

export function parseRobots(txt: string, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase().split('/')[0]!.trim();
  type Group = { agents: string[]; allow: string[]; disallow: string[]; delay: number | null };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], allow: [], disallow: [], delay: null };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (field === 'allow' && value) cur.allow.push(value);
    else if (field === 'disallow' && value) cur.disallow.push(value);
    else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) cur.delay = n * 1000;
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return {
    allow: chosen.flatMap((g) => g.allow),
    disallow: chosen.flatMap((g) => g.disallow),
    crawlDelayMs: chosen.reduce<number | null>((m, g) => (g.delay === null ? m : Math.max(m ?? 0, g.delay)), null),
  };
}

function ruleToRegex(rule: string): RegExp {
  const anchored = rule.endsWith('$');
  const body = (anchored ? rule.slice(0, -1) : rule)
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

export function policyFromRules(rules: RobotsRules): RobotsPolicy {
  const compiled = [
    ...rules.allow.map((r) => ({ allow: true, len: r.length, re: ruleToRegex(r) })),
    ...rules.disallow.map((r) => ({ allow: false, len: r.length, re: ruleToRegex(r) })),
  ];
  return {
    crawlDelayMs: rules.crawlDelayMs,
    isAllowed(p: string) {
      let best: { allow: boolean; len: number } | null = null;
      for (const c of compiled) {
        if (!c.re.test(p)) continue;
        if (!best || c.len > best.len || (c.len === best.len && c.allow)) best = c;
      }
      return best ? best.allow : true;
    },
  };
}

export const DENY_ALL: RobotsPolicy = { isAllowed: () => false, crawlDelayMs: null };
export const ALLOW_ALL: RobotsPolicy = { isAllowed: () => true, crawlDelayMs: null };
