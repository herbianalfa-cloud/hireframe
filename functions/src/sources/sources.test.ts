import { normaliseRawJob, RawJobSchema, type RawJob } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { createAdzunaSource } from './adzuna.js';
import { createAshbySource } from './ashby.js';
import { boardsThisRun } from './ats.js';
import { createGreenhouseSource } from './greenhouse.js';
import { createHnSource, isUkRelevant, linksIn, parseHnHeader } from './hn.js';
import { createSources } from './index.js';
import { createLeverSource } from './lever.js';
import { createReedSource, parseReedDate } from './reed.js';
import { testContext, testHttpClient } from './testing.js';
import type { WatchedCompany } from './types.js';
import { createWorkableSource, workableBoardUrl } from './workable.js';

function expectValid(jobs: RawJob[]) {
  for (const job of jobs) expect(RawJobSchema.parse(job)).toEqual(job);
}

describe('ATS sources on fixtures', () => {
  it('Greenhouse: maps postings, counts the invalid one, marks the missing board', async () => {
    const source = createGreenhouseSource();
    const jobs = await source.fetch(testContext());
    expectValid(jobs);
    expect(jobs.map((job) => job.title)).toEqual(['Product Analyst', 'Senior Software Engineer']);
    expect(jobs[0]).toMatchObject({
      externalId: '5551234',
      company: 'Acme Analytics',
      companyId: 'acme-analytics',
      locationText: 'London, UK',
      postedAt: new Date('2026-09-28T13:00:00Z'),
    });
    const [first] = jobs;
    if (!first) throw new Error('no job');
    expect(normaliseRawJob(first)?.description.text).toBe(
      'Acme Analytics builds reporting tools for B2B SaaS teams.\n\n• SQL & dashboards\n• Work with product managers',
    );
    expect(source.health()).toMatchObject({
      status: 'degraded',
      fetched: 3,
      invalid: 1,
      errors: 1,
      boards: expect.arrayContaining([
        { companyId: 'acme-analytics', status: 'ok', jobs: 2 },
        { companyId: 'echo-gone', status: 'not_found', jobs: 0, errorCode: 'not_found' },
      ]) as unknown,
    });
  });

  it('Lever: joins description, lists and extras; reads workplace and salary', async () => {
    const source = createLeverSource();
    const jobs = await source.fetch(testContext());
    expectValid(jobs);
    expect(jobs.map((job) => job.title)).toEqual([
      'Senior Product Analyst',
      'Junior Product Analyst',
    ]);
    expect(jobs[0]?.description.body).toContain('<h3>Requirements</h3><ul><li>5+ years');
    expect(jobs[0]).toMatchObject({ remoteHint: 'hybrid', locationText: 'London, GB' });
    expect(jobs[1]?.salary).toEqual({ currency: 'GBP', period: 'year', min: 32000, max: 38000 });
    expect(source.health().status).toBe('ok');
  });

  it('Ashby: skips unlisted postings and reads the salary component', async () => {
    const source = createAshbySource();
    const jobs = await source.fetch(testContext());
    expectValid(jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'Product Analyst',
      remoteHint: 'hybrid',
      locationText: 'London, United Kingdom',
      salary: { currency: 'GBP', period: 'year', min: 35000, max: 42000 },
    });
    expect(source.health()).toMatchObject({ status: 'ok', fetched: 2, invalid: 0 });
  });

  it('Workable: uses visible locations and the remote flag', async () => {
    const source = createWorkableSource();
    const jobs = await source.fetch(testContext());
    expectValid(jobs);
    expect(jobs[0]).toMatchObject({
      externalId: 'A1B2C3D4E5',
      url: 'https://apply.workable.com/j/A1B2C3D4E5',
      locationText: 'Manchester, United Kingdom',
      remoteHint: 'remote',
    });
  });

  it('is skipped when no watched company uses that ATS', async () => {
    const source = createGreenhouseSource();
    await expect(source.fetch(testContext({ companies: [] }))).resolves.toEqual([]);
    expect(source.health().status).toBe('skipped');
  });

  it('is failing when every board fails', async () => {
    const source = createGreenhouseSource();
    const companies = [{ id: 'x', name: 'X', ats: { type: 'greenhouse', token: 'gone' } }] as const;
    await source.fetch(testContext({ companies }));
    expect(source.health()).toMatchObject({ status: 'failing', errors: 1 });
  });
});

describe('Reed', () => {
  it('maps search results with Basic auth and records the calls used', async () => {
    const seen: { auth?: string | null; url: string }[] = [];
    const http = testHttpClient({
      fetch: ((url: URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: url.toString(), auth: headers.get('authorization') });
        return import('./fake-fetch.js').then(({ fakeFetch }) => fakeFetch(url));
      }) as typeof fetch,
    });
    const source = createReedSource();
    const jobs = await source.fetch(testContext({ http, callBudget: 2 }));
    expectValid(jobs);
    expect(jobs[0]).toMatchObject({
      externalId: '50001234',
      title: 'Product Analyst (Hybrid) - London',
      company: 'Cobalt Ledger Limited',
      description: { kind: 'snippet' },
      postedAt: new Date(Date.UTC(2026, 8, 26)),
      salary: { currency: 'GBP', period: 'unknown', min: 35000, max: 42000 },
    });
    // robots.txt is never fetched for the keyed API (ADR-025).
    expect(seen.every((call) => !call.url.endsWith('/robots.txt'))).toBe(true);
    expect(seen[0]?.auth).toBe(`Basic ${Buffer.from('fake-reed:').toString('base64')}`);
    expect(source.health()).toMatchObject({ status: 'ok', callsUsed: 2, nextQueryCursor: 0 });
  });

  it('is disabled without a key and skipped without criteria or budget', async () => {
    const source = createReedSource();
    await source.fetch(testContext({ secrets: {} }));
    expect(source.health()).toMatchObject({ status: 'disabled', errorCode: 'no_key' });
    await source.fetch(testContext({ criteria: null }));
    expect(source.health()).toMatchObject({ status: 'skipped', errorCode: 'no_criteria' });
    await source.fetch(testContext({ callBudget: 0 }));
    expect(source.health()).toMatchObject({ status: 'skipped', errorCode: 'quota_used' });
  });

  it('parses dd/mm/yyyy dates', () => {
    expect(parseReedDate('01/10/2026')).toEqual(new Date(Date.UTC(2026, 9, 1)));
    expect(parseReedDate('2026-10-01')).toBeUndefined();
  });
});

describe('Adzuna', () => {
  it('strips highlight tags from titles and never exceeds the call budget', async () => {
    const source = createAdzunaSource();
    const jobs = await source.fetch(testContext({ callBudget: 3 }));
    expectValid(jobs);
    expect(jobs[0]).toMatchObject({
      externalId: '4900000001',
      title: 'Product Analyst - London - £35,000',
      company: 'ACME ANALYTICS LTD',
      salary: { currency: 'GBP', period: 'year', min: 35000, max: 35000 },
    });
    expect(source.health()).toMatchObject({ status: 'ok', callsUsed: 3 });
  });

  it('stops at once when Adzuna rate-limits beyond the cap', async () => {
    const http = testHttpClient({
      fetch: () =>
        Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '3600' } })),
    });
    const source = createAdzunaSource();
    await source.fetch(testContext({ http, callBudget: 5 }));
    expect(source.health()).toMatchObject({ status: 'degraded', errors: 1, callsUsed: 1 });
  });
});

describe('HN', () => {
  it('keeps UK and Europe-remote postings from the latest hiring thread', async () => {
    const source = createHnSource();
    const jobs = await source.fetch(testContext());
    expectValid(jobs);
    expect(jobs.map((job) => [job.company, job.title, job.locationText])).toEqual([
      ['Acme Analytics', 'Product Analyst', 'London, UK | Hybrid'],
      ['Foxglove Health', 'Solutions Engineer', 'REMOTE (Europe)'],
    ]);
    expect(jobs[0]?.extraUrls).toEqual(['https://boards.greenhouse.io/acmeanalytics/jobs/5551234']);
    expect(source.health()).toMatchObject({ status: 'ok', fetched: 3 });
  });

  it.each([
    ['Acme | Engineer | London, UK | Full-time', true],
    ['Acme | Engineer | REMOTE (Worldwide)', true],
    ['Acme | Engineer | Remote (EU timezones)', true],
    ['Acme | Engineer | Remote (US only)', false],
    ['Acme | Engineer | San Francisco, CA | ONSITE', false],
    ['Acme | Engineer | US, UK, EU', true],
  ])('UK relevance: %s → %s', (header, expected) => {
    expect(isUkRelevant(header)).toBe(expected);
  });

  it('parses headers in any order and falls back to "Multiple roles"', () => {
    expect(
      parseHnHeader('Acme (https://acme.example) | Full-time | London | Data Engineer'),
    ).toEqual({ company: 'Acme', title: 'Data Engineer', locationText: 'London' });
    expect(parseHnHeader('Acme | London, UK | Full-time | £50k')).toEqual({
      company: 'Acme',
      title: 'Multiple roles',
      locationText: 'London, UK',
    });
    expect(parseHnHeader('   ')).toBeNull();
  });

  it('decodes links and drops non-http ones', () => {
    expect(
      linksIn('<a href="https:&#x2F;&#x2F;x.example&#x2F;a">a</a><a href="mailto:x">m</a>'),
    ).toEqual(['https://x.example/a']);
  });
});

describe('createSources', () => {
  it('creates one fresh module per scan source', () => {
    const sources = createSources();
    expect(Object.keys(sources)).toEqual([
      'greenhouse',
      'lever',
      'ashby',
      'workable',
      'reed',
      'adzuna',
      'hn',
    ]);
    expect(createSources().greenhouse).not.toBe(sources.greenhouse);
  });
});

describe('board rotation when a host is full (ADR-029)', () => {
  const workable = (id: string, lastScannedAt?: string): WatchedCompany => ({
    id,
    name: id,
    ats: { type: 'workable', token: id },
    ...(lastScannedAt ? { lastScannedAt: new Date(lastScannedAt) } : {}),
  });
  const url = (company: WatchedCompany) => workableBoardUrl(company.ats.token ?? '');

  it('fits Workable boards into the budget at 5 s each: 36 a run', () => {
    const many = Array.from({ length: 50 }, (_, i) => workable(`co-${String(i).padStart(2, '0')}`));
    const { selected, deferred } = boardsThisRun(many, url);
    expect(selected).toHaveLength(36);
    expect(deferred).toBe(14);
    // 36 boards × 5 s stays inside the 300 s fetch deadline with room for retries (ADR-032).
    expect(selected.length * 5_000).toBeLessThanOrEqual(300_000 * 0.6);
  });

  it('takes never-scanned boards first, then the oldest, ties by ID', () => {
    const companies = [
      workable('c', '2026-10-02T08:00:00Z'),
      workable('b'),
      workable('a', '2026-10-01T08:00:00Z'),
      workable('d'),
    ];
    const { selected, deferred } = boardsThisRun(companies, url, 10_000); // room for 2
    expect(selected.map((company) => company.id)).toEqual(['b', 'd']);
    expect(deferred).toBe(2);
    expect(boardsThisRun(companies, url, 20_000).selected.map((c) => c.id)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });

  it('caps each host on its own interval, so a full host never holds back another', () => {
    const greenhouse: WatchedCompany = {
      id: 'g',
      name: 'g',
      ats: { type: 'greenhouse', token: 'g' },
    };
    const boardUrl = (company: WatchedCompany) =>
      company.ats.type === 'greenhouse'
        ? 'https://boards-api.greenhouse.io/v1/boards/g/jobs'
        : url(company);
    const { selected } = boardsThisRun([workable('a'), workable('b'), greenhouse], boardUrl, 5_000);
    expect(selected.map((company) => company.id)).toEqual(['a', 'g']);
  });

  it('reports deferred boards and fetches only the selected ones', async () => {
    const requested: string[] = [];
    const http = testHttpClient({
      fetch: ((input: URL) => {
        requested.push(input.toString());
        return Promise.resolve(new Response('', { status: 404 }));
      }) as typeof fetch,
    });
    const many = Array.from({ length: 45 }, (_, i) => workable(`co-${String(i).padStart(2, '0')}`));
    const source = createWorkableSource();
    await source.fetch(testContext({ http, companies: many }));
    expect(requested.filter((u) => u.includes('/widget/accounts/'))).toHaveLength(36);
    expect(source.health().deferred).toBe(9);
  });
});

describe('paused hosts (Retry-After beyond the cap)', () => {
  const companies: WatchedCompany[] = ['a', 'b', 'c'].map((id) => ({
    id,
    name: id,
    ats: { type: 'workable', token: id },
  }));

  it('stops asking a host after it says come back later', async () => {
    const requested: string[] = [];
    const http = testHttpClient({
      fetch: ((input: URL) => {
        requested.push(input.toString());
        return Promise.resolve(
          new Response('error code: 1015', { status: 429, headers: { 'retry-after': '83997' } }),
        );
      }) as typeof fetch,
    });
    const source = createWorkableSource();
    await source.fetch(testContext({ http, companies }));
    expect(requested.filter((u) => u.includes('/widget/accounts/'))).toHaveLength(1);
    const report = source.health();
    expect(report.boards.map((board) => board.errorCode).sort()).toEqual([
      'host_paused',
      'host_paused',
      'rate_limited',
    ]);
    // One board was really tried and failed; the two skipped ones don't count.
    expect(report.status).toBe('failing');
    expect(http.pauses()).toHaveLength(1);
  });

  it('is skipped, without a request, while a carried-over pause lasts', async () => {
    const requested: string[] = [];
    const http = testHttpClient({
      fetch: ((input: URL) => {
        requested.push(input.toString());
        return Promise.resolve(new Response('', { status: 404 }));
      }) as typeof fetch,
      paused: [{ host: 'apply.workable.com', until: Date.parse('2026-10-02T08:00:00Z') }],
    });
    const source = createWorkableSource();
    await source.fetch(testContext({ http, companies }));
    expect(requested).toEqual([]);
    expect(source.health()).toMatchObject({ status: 'skipped', errorCode: 'host_paused' });
  });
});
