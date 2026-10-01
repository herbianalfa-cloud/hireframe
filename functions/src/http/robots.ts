/**
 * robots.txt (RFC 9309) for the source HTTP client (ADR-025). Pure.
 * - Groups: consecutive `User-agent` lines share the rules that follow. The groups naming our
 *   product token are merged; if none does, the `*` groups apply.
 * - Rules: the longest matching `Allow`/`Disallow` path wins; on a tie `Allow` wins. `*` matches
 *   any run of characters and a trailing `$` anchors the end. An empty `Disallow` allows all.
 * - `Crawl-delay` (not in the RFC, but honoured) is read from the same groups.
 */

interface Rule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}

export interface RobotsPolicy {
  allows(pathAndQuery: string): boolean;
  crawlDelayMs?: number;
}

export const ALLOW_ALL: RobotsPolicy = { allows: () => true };
export const DISALLOW_ALL: RobotsPolicy = { allows: () => false };

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelaySeconds?: number;
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let collectingAgents = false;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
      continue;
    }
    if (!current) continue;
    collectingAgents = false;
    if (key === 'allow' || key === 'disallow') {
      if (value === '') continue;
      current.rules.push({ allow: key === 'allow', pattern: value, regex: patternToRegex(value) });
    } else if (key === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }
  return groups;
}

/** The policy for `productToken` (e.g. `HireframeBot`) from a robots.txt body. */
export function parseRobots(text: string, productToken: string): RobotsPolicy {
  const token = productToken.toLowerCase();
  const groups = parseGroups(text);
  const named = groups.filter((group) => group.agents.includes(token));
  const applicable = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  const rules = applicable.flatMap((group) => group.rules);
  const delays = applicable
    .map((group) => group.crawlDelaySeconds)
    .filter((delay): delay is number => delay !== undefined);
  return {
    allows(pathAndQuery) {
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!rule.regex.test(pathAndQuery)) continue;
        if (
          !best ||
          rule.pattern.length > best.pattern.length ||
          (rule.pattern.length === best.pattern.length && rule.allow)
        ) {
          best = rule;
        }
      }
      return best?.allow ?? true;
    },
    ...(delays.length > 0 ? { crawlDelayMs: Math.max(...delays) * 1000 } : {}),
  };
}

/**
 * The policy implied by a robots.txt fetch result (RFC 9309 §2.3.1): 2xx → its rules; 4xx → no
 * rules (allow all); 5xx or unreachable → disallow all until a later run gets a real answer.
 */
export function robotsFromResponse(
  result: { status: number; body: string } | null,
  productToken: string,
): RobotsPolicy {
  if (!result || result.status >= 500) return DISALLOW_ALL;
  if (result.status >= 400) return ALLOW_ALL;
  if (result.status >= 200 && result.status < 300) return parseRobots(result.body, productToken);
  return DISALLOW_ALL;
}
