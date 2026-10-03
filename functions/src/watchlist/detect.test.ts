import { CompanySeedSchema } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { createHttpClient } from '../http/client.js';
import {
  atsFromUrl,
  boardPageUrl,
  classify,
  detectCandidate,
  mergeRechecked,
  namesMatch,
  parseCsv,
  REVIEW_HEADER,
  reviewRow,
  seedFromReview,
  seedModule,
  slugify,
  toCsv,
  tokenCandidates,
  type BoardHit,
} from './detect.js';

const ACME = { name: 'Acme Analytics Ltd', domain: 'acme-analytics.example.com', hq: 'London' };

describe('token guesses and URL parsing', () => {
  it('guesses joined, hyphenated, domain and first-word tokens', () => {
    expect(tokenCandidates(ACME.name, ACME.domain)).toEqual([
      'acmeanalytics',
      'acme-analytics',
      'acme',
    ]);
    expect(tokenCandidates('Bloom', 'www.bloomhq.example')).toEqual(['bloom', 'bloomhq']);
  });

  it.each([
    ['https://boards.greenhouse.io/acme', { type: 'greenhouse', token: 'acme' }],
    ['https://job-boards.greenhouse.io/acme/jobs/123', { type: 'greenhouse', token: 'acme' }],
    [
      'https://boards.greenhouse.io/embed/job_board?for=acme',
      { type: 'greenhouse', token: 'acme' },
    ],
    ['https://jobs.lever.co/acme/abc', { type: 'lever', token: 'acme' }],
    ['https://jobs.eu.lever.co/acme', { type: 'lever', token: 'acme', host: 'eu' }],
    ['https://jobs.ashbyhq.com/acme', { type: 'ashby', token: 'acme' }],
    ['https://apply.workable.com/acme/', { type: 'workable', token: 'acme' }],
    ['https://acme.workable.com/', { type: 'workable', token: 'acme' }],
    ['https://apply.workable.com/j/ABC123', null],
    ['https://acme.example.com/careers', null],
    ['not a url', null],
  ])('%s', (url, expected) => {
    expect(atsFromUrl(url)).toEqual(expected);
  });

  it.each([
    ['Acme Analytics', 'Acme Analytics Ltd', true],
    ['Careers at Tide', 'Tide', true],
    ['Cleo (US)', 'Cleo', true],
    ['Form3 - External', 'Form3', true],
    ['Thought Machine Group Limited', 'Thought Machine', true],
    // A prefix is not a match: these were wrong-company confirmations in the first live run.
    ['Wise Worksite Field Sales', 'Wise', false],
    ['Peak Physical Therapy - Upstream', 'Peak', false],
    ['Starling', 'Starling Bank', false],
    ['ACME', 'Acme Analytics', false],
    ['Bloom Credit', 'Bloom & Wild', false],
  ])('namesMatch(%s, %s) → %s', (board, company, expected) => {
    expect(namesMatch(board, company)).toBe(expected);
  });

  it('builds human board URLs', () => {
    expect(boardPageUrl({ type: 'lever', token: 'acme', host: 'eu' })).toBe(
      'https://jobs.eu.lever.co/acme',
    );
  });
});

describe('classify', () => {
  const gh: BoardHit = {
    type: 'greenhouse',
    token: 'acme',
    boardName: 'Acme Analytics',
    jobs: 4,
    ukJobs: 3,
  };
  const lever: BoardHit = { type: 'lever', token: 'acme', jobs: 2, ukJobs: 0 };

  it('confirms a single board whose name matches', () => {
    expect(classify(ACME, [gh], false)).toMatchObject({ status: 'confirmed', hit: gh });
  });

  it('sends nameless boards and multiple hits to review', () => {
    expect(classify(ACME, [lever], false).status).toBe('review');
    expect(classify(ACME, [lever, gh], false)).toMatchObject({
      status: 'review',
      hit: gh,
      others: [lever],
    });
    expect(classify(ACME, [{ ...gh, boardName: 'Other Co' }], false).status).toBe('review');
  });

  const emptyWorkable: BoardHit = {
    type: 'workable',
    token: 'acme',
    boardName: 'Acme Analytics',
    jobs: 0,
    ukJobs: 0,
  };

  it('prefers a live board over a dormant one that matches by name', () => {
    // The Synthesia case: an empty Workable account must not beat the live Ashby board.
    const ashby: BoardHit = { type: 'ashby', token: 'acme', jobs: 12, ukJobs: 5 };
    expect(classify(ACME, [emptyWorkable, ashby], false)).toMatchObject({
      status: 'review', // Ashby gives no board name to confirm
      hit: ashby,
      others: [emptyWorkable],
    });
  });

  it('confirms the one live board when the others are empty', () => {
    expect(classify(ACME, [emptyWorkable, gh], false)).toMatchObject({
      status: 'confirmed',
      hit: gh,
      others: [emptyWorkable],
    });
  });

  it('marks ties as review: several live boards, or several empty ones', () => {
    const liveWorkable: BoardHit = { ...emptyWorkable, jobs: 9, ukJobs: 9 };
    expect(classify(ACME, [gh, liveWorkable], false)).toMatchObject({
      status: 'review',
      hit: liveWorkable, // both names match, so the one with more jobs leads
      others: [gh],
    });
    const emptyGh: BoardHit = { ...gh, jobs: 0, ukJobs: 0 };
    expect(classify(ACME, [emptyGh, emptyWorkable], false).status).toBe('review');
    expect(classify(ACME, [lever, { ...lever, type: 'ashby', jobs: 7 }], true).status).toBe(
      'review',
    );
  });

  it('picks the board with the most jobs when no name matches', () => {
    const ashby: BoardHit = { type: 'ashby', token: 'acme', jobs: 7, ukJobs: 1 };
    expect(classify(ACME, [lever, ashby], false)).toMatchObject({ status: 'review', hit: ashby });
  });

  it('never confirms an empty board, even when its name matches', () => {
    expect(classify(ACME, [emptyWorkable], false)).toMatchObject({
      status: 'review',
      hit: emptyWorkable,
    });
    expect(classify(ACME, [{ ...lever, jobs: 0 }], true).status).toBe('review');
  });

  it('confirms a board from a URL the owner pasted', () => {
    expect(classify(ACME, [lever], true).status).toBe('confirmed');
  });
});

describe('CSV round trip and seed generation', () => {
  it('parses quotes, commas and blank lines', () => {
    expect(parseCsv('name,notes\n"Acme, Inc","said ""hi"""\n\nBeta,\n')).toEqual([
      { name: 'Acme, Inc', notes: 'said "hi"' },
      { name: 'Beta', notes: '' },
    ]);
  });

  it('turns reviewed rows into a sorted, valid seed', () => {
    const rows = [
      reviewRow({
        candidate: ACME,
        status: 'confirmed',
        hit: {
          type: 'greenhouse',
          token: 'acmeanalytics',
          boardName: 'Acme Analytics',
          jobs: 3,
          ukJobs: 2,
        },
        others: [],
      }),
      reviewRow({
        candidate: { name: 'Bramble', domain: 'bramble.example.com', hq: 'Leeds' },
        status: 'review',
        hit: { type: 'lever', token: 'bramble', host: 'eu', jobs: 1, ukJobs: 1 },
        others: [],
      }),
      reviewRow({
        candidate: { name: 'Cobalt', domain: 'cobalt.example.com', hq: 'London' },
        status: 'not-found',
        others: [],
      }),
    ];
    const csv = toCsv(REVIEW_HEADER, rows);
    const parsed = parseCsv(csv);
    expect(seedFromReview(parsed).undecided).toEqual(['Bramble']);

    const decided = parsed.map((row) =>
      row.name === 'Bramble'
        ? { ...row, decision: 'keep' }
        : row.name === 'Cobalt'
          ? { ...row, decision: 'keep-none' }
          : row,
    );
    const { seed, undecided } = seedFromReview(decided);
    expect(undecided).toEqual([]);
    expect(seed).toEqual([
      {
        id: 'acme-analytics',
        name: 'Acme Analytics Ltd',
        domain: 'acme-analytics.example.com',
        ats: { type: 'greenhouse', token: 'acmeanalytics' },
        hq: 'London',
      },
      {
        id: 'bramble',
        name: 'Bramble',
        domain: 'bramble.example.com',
        ats: { type: 'lever', token: 'bramble', host: 'eu' },
        hq: 'Leeds',
      },
      {
        id: 'cobalt',
        name: 'Cobalt',
        domain: 'cobalt.example.com',
        ats: { type: 'none' },
        hq: 'London',
      },
    ]);
    for (const company of seed) expect(CompanySeedSchema.safeParse(company).success).toBe(true);
    expect(seedFromReview(decided.map((row) => ({ ...row, decision: 'drop' }))).seed).toEqual([]);
    expect(seedModule(seed)).toContain('export const WATCHLIST_SEED: readonly CompanySeed[] = [');
  });

  it('slugifies names into document IDs', () => {
    expect(slugify('Smith & Jones Ltd')).toBe('smith-and-jones');
  });
});

function probeClient(fetchFake: (url: URL) => Promise<Response>) {
  return createHttpClient({
    fetch: fetchFake as typeof fetch,
    now: () => 0,
    sleep: () => Promise.resolve(),
    random: () => 0,
    userAgent: 'test',
    productToken: 'HireframeBot',
    hostPolicy: () => ({ robots: 'enforce', intervalMs: 0, timeoutMs: 1000 }),
    maxAttempts: 1,
    backoffBaseMs: 0,
    retryAfterCapMs: 0,
    maxBodyBytes: 1_000_000,
    log: () => undefined,
  });
}

const rateLimited = () => Promise.resolve(new Response('error code: 1015', { status: 429 }));
const notFound = () => Promise.resolve(new Response('', { status: 404 }));

describe('detectCandidate when a probe fails', () => {
  it('is unchecked, not not-found, when a rate-limited probe could have been the board', async () => {
    const http = probeClient((url) =>
      url.host === 'apply.workable.com' && url.pathname !== '/robots.txt'
        ? rateLimited()
        : notFound(),
    );
    const detection = await detectCandidate(http, ACME);
    expect(detection.status).toBe('unchecked');
    expect(detection.failed).toEqual([
      'workable:acmeanalytics',
      'workable:acme-analytics',
      'workable:acme',
    ]);
    const [row] = parseCsv(toCsv(REVIEW_HEADER, [reviewRow(detection)]));
    expect(row).toMatchObject({ status: 'unchecked', decision: '' });
    expect(seedFromReview(row ? [row] : []).undecided).toEqual(['Acme Analytics Ltd']);
  });

  it('downgrades a confirmation to review when another probe failed', async () => {
    const http = probeClient((url) => {
      if (url.host === 'apply.workable.com' && url.pathname !== '/robots.txt') return rateLimited();
      if (url.href === 'https://boards-api.greenhouse.io/v1/boards/acmeanalytics/jobs') {
        return Promise.resolve(
          Response.json({
            jobs: [
              {
                id: 1,
                title: 'Analyst',
                absolute_url: 'https://job-boards.greenhouse.io/a/jobs/1',
              },
            ],
          }),
        );
      }
      if (url.href === 'https://boards-api.greenhouse.io/v1/boards/acmeanalytics') {
        return Promise.resolve(Response.json({ name: 'Acme Analytics' }));
      }
      return notFound();
    });
    const detection = await detectCandidate(http, ACME);
    expect(detection).toMatchObject({
      status: 'review',
      hit: { type: 'greenhouse' },
      failed: ['workable:acmeanalytics'],
    });
  });
});

describe('detectCandidate', () => {
  it('probes official APIs only, stopping at the first token that hits', async () => {
    const requested: string[] = [];
    const http = createHttpClient({
      fetch: ((url: URL) => {
        requested.push(url.toString());
        const href = url.toString();
        if (href === 'https://boards-api.greenhouse.io/v1/boards/acmeanalytics/jobs') {
          return Promise.resolve(
            Response.json({
              jobs: [
                {
                  id: 1,
                  title: 'Product Analyst',
                  absolute_url: 'https://job-boards.greenhouse.io/acmeanalytics/jobs/1',
                  location: { name: 'London' },
                },
              ],
            }),
          );
        }
        if (href === 'https://boards-api.greenhouse.io/v1/boards/acmeanalytics') {
          return Promise.resolve(Response.json({ name: 'Acme Analytics', content: '' }));
        }
        return Promise.resolve(new Response('', { status: 404 }));
      }) as typeof fetch,
      now: () => 0,
      sleep: () => Promise.resolve(),
      random: () => 0,
      userAgent: 'test',
      productToken: 'HireframeBot',
      hostPolicy: () => ({ robots: 'enforce', intervalMs: 0, timeoutMs: 1000 }),
      maxAttempts: 1,
      backoffBaseMs: 0,
      retryAfterCapMs: 0,
      maxBodyBytes: 1_000_000,
      log: () => undefined,
    });
    const detection = await detectCandidate(http, ACME);
    expect(detection).toMatchObject({
      status: 'confirmed',
      hit: {
        type: 'greenhouse',
        token: 'acmeanalytics',
        boardName: 'Acme Analytics',
        jobs: 1,
        ukJobs: 1,
      },
    });
    // Only robots.txt and the four job-board APIs, and only the first token.
    const hosts = new Set(requested.map((url) => new URL(url).host));
    expect([...hosts].sort()).toEqual([
      'api.ashbyhq.com',
      'api.eu.lever.co',
      'api.lever.co',
      'apply.workable.com',
      'boards-api.greenhouse.io',
    ]);
    expect(requested.some((url) => url.includes('acme-analytics'))).toBe(false);
  });
});

describe('mergeRechecked (--recheck)', () => {
  it('replaces only re-detected rows and keeps decisions and extra columns elsewhere', () => {
    const header = [...REVIEW_HEADER, 'decisionReason'];
    const reviewed = reviewRow({
      candidate: ACME,
      status: 'confirmed',
      hit: {
        type: 'greenhouse',
        token: 'acmeanalytics',
        boardName: 'Acme Analytics',
        jobs: 3,
        ukJobs: 2,
      },
      others: [],
    });
    const pending = reviewRow({
      candidate: { name: 'Bramble', domain: 'bramble.example.com', hq: 'Leeds' },
      status: 'unchecked',
      others: [],
      failed: ['workable:bramble'],
    });
    const rows = parseCsv(
      toCsv(header, [
        [...reviewed.slice(0, -1), 'drop', 'owner said so'],
        [...pending, 'unchecked: retry pending'],
      ]),
    );
    const recheckedBramble = {
      candidate: { name: 'Bramble', domain: 'bramble.example.com', hq: 'Leeds' },
      status: 'confirmed' as const,
      hit: {
        type: 'workable' as const,
        token: 'bramble',
        boardName: 'Bramble',
        jobs: 4,
        ukJobs: 4,
      },
      others: [],
    };
    const merged = mergeRechecked(rows, [recheckedBramble]);
    expect(merged.header).toEqual([...REVIEW_HEADER, 'decisionreason']);
    expect(merged.rows[0]).toEqual(rows[0]); // untouched, the owner's drop kept
    expect(merged.rows[1]).toMatchObject({
      name: 'Bramble',
      status: 'confirmed',
      ats: 'workable',
      token: 'bramble',
      failed_probes: '',
      decision: 'keep',
      decisionreason: 'rechecked: confirmed',
    });
  });
});
