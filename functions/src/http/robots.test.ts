import { describe, expect, it } from 'vitest';

import { parseRobots, robotsFromResponse } from './robots.js';

const TOKEN = 'HireframeBot';

// Real files as fetched on 2026-10-01 (ADR-025), trimmed to the parts that matter.
const GREENHOUSE = `# See http://www.robotstxt.org/robotstxt.html
User-agent: *
Disallow: /embed/
`;
const LEVER = `User-agent: *
Allow: /
Crawl-delay: 1
`;
const REED = `User-agent: AnthropicBot
Allow: /

User-agent: JoobleBot
Crawl-delay: 3

User-agent: *
User-agent: bingbot
User-agent: Googlebot
Disallow: /linkclicked.html
Disallow: /api/
Disallow: /*?sourceInternal=
Disallow: /jobs/*?*sortBy=
`;
const ADZUNA = `User-agent: *
Disallow: /
`;
const APPLY_WORKABLE = `User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=no
Disallow:
`;
const WORKABLE = `User-Agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=no
Disallow: /user_password_resets
Disallow: /admin
Disallow: /j/
`;

describe('parseRobots on the real source files', () => {
  it('Greenhouse allows the job board API and blocks /embed/', () => {
    const robots = parseRobots(GREENHOUSE, TOKEN);
    expect(robots.allows('/v1/boards/acme/jobs?content=true')).toBe(true);
    expect(robots.allows('/embed/job_board?for=acme')).toBe(false);
    expect(robots.crawlDelayMs).toBeUndefined();
  });

  it('Lever allows everything with a 1 s crawl delay', () => {
    const robots = parseRobots(LEVER, TOKEN);
    expect(robots.allows('/v0/postings/acme?mode=json')).toBe(true);
    expect(robots.crawlDelayMs).toBe(1000);
  });

  it('Reed disallows /api/ for us (the keyed API follows its terms instead, ADR-025)', () => {
    const robots = parseRobots(REED, TOKEN);
    expect(robots.allows('/api/1.0/search?keywords=x')).toBe(false);
    expect(robots.allows('/jobs/product-analyst/123')).toBe(true);
    expect(robots.allows('/jobs/london?page=2&sortBy=date')).toBe(false);
    expect(robots.allows('/x?sourceInternal=1')).toBe(false);
    // JoobleBot's delay belongs to another group.
    expect(robots.crawlDelayMs).toBeUndefined();
  });

  it('Adzuna disallows its whole API host', () => {
    expect(parseRobots(ADZUNA, TOKEN).allows('/v1/api/jobs/gb/search/1')).toBe(false);
  });

  it('Workable allows the public jobs endpoint on both hosts', () => {
    const robots = parseRobots(WORKABLE, TOKEN);
    expect(robots.allows('/api/accounts/acme?details=true')).toBe(true);
    expect(robots.allows('/j/ABC123')).toBe(false);
    // apply.workable.com, which the scan calls directly (ADR-027), allows everything.
    const apply = parseRobots(APPLY_WORKABLE, TOKEN);
    expect(apply.allows('/api/v1/widget/accounts/acme?details=true')).toBe(true);
  });
});

describe('parseRobots rules', () => {
  it('uses the group naming our token instead of *', () => {
    const robots = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: hireframebot\nAllow: /\nCrawl-delay: 2',
      TOKEN,
    );
    expect(robots.allows('/anything')).toBe(true);
    expect(robots.crawlDelayMs).toBe(2000);
  });

  it('picks the longest match, and Allow on a tie', () => {
    const robots = parseRobots(
      'User-agent: *\nDisallow: /jobs\nAllow: /jobs/open\nDisallow: /x\nAllow: /x',
      TOKEN,
    );
    expect(robots.allows('/jobs/closed')).toBe(false);
    expect(robots.allows('/jobs/open/1')).toBe(true);
    expect(robots.allows('/x')).toBe(true);
  });

  it('supports * and $', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /*.json$\nDisallow: /a*b', TOKEN);
    expect(robots.allows('/feed.json')).toBe(false);
    expect(robots.allows('/feed.json?x=1')).toBe(true);
    expect(robots.allows('/a/long/b')).toBe(false);
    expect(robots.allows('/ab-not')).toBe(false);
    expect(robots.allows('/c')).toBe(true);
  });

  it('treats an empty Disallow and an empty file as allow-all', () => {
    expect(parseRobots('User-agent: *\nDisallow:', TOKEN).allows('/x')).toBe(true);
    expect(parseRobots('', TOKEN).allows('/x')).toBe(true);
  });

  it('escapes regex characters in paths', () => {
    expect(parseRobots('User-agent: *\nDisallow: /a.b', TOKEN).allows('/axb')).toBe(true);
  });
});

describe('robotsFromResponse (RFC 9309 §2.3.1)', () => {
  it('4xx means no rules, 5xx and unreachable mean disallow all', () => {
    expect(robotsFromResponse({ status: 404, body: '' }, TOKEN).allows('/x')).toBe(true);
    expect(robotsFromResponse({ status: 401, body: '' }, TOKEN).allows('/x')).toBe(true);
    expect(robotsFromResponse({ status: 503, body: '' }, TOKEN).allows('/x')).toBe(false);
    expect(robotsFromResponse(null, TOKEN).allows('/x')).toBe(false);
    expect(robotsFromResponse({ status: 200, body: ADZUNA }, TOKEN).allows('/x')).toBe(false);
  });
});
