import { describe, expect, it } from 'vitest';

import {
  RESULTS_CARDS,
  resultsPageLinks,
  resultsPageText,
  UNREADABLE_PASTE,
} from './fixtures/results-page.js';
import {
  ageToPostedAt,
  LOOKUP_LIMITS,
  LookupInputSchema,
  parseAtsUrl,
  parseLookupInput,
  parseResultsPage,
} from './lookup.js';

describe('parseLookupInput', () => {
  it('reads every LinkedIn URL form to one canonical URL and key', () => {
    const forms = [
      'https://www.linkedin.com/jobs/view/4012345678/',
      'https://www.linkedin.com/jobs/view/4012345678/?trackingId=abc&refId=x',
      'https://uk.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc',
      'https://www.linkedin.com/jobs/view/product-analyst-at-acme-4012345678',
    ];
    for (const form of forms) {
      const [target, ...rest] = parseLookupInput(form);
      expect(rest).toEqual([]);
      expect(target).toMatchObject({
        url: 'https://www.linkedin.com/jobs/view/4012345678',
        keys: ['linkedin:4012345678'],
        linkedinId: '4012345678',
      });
    }
  });

  it('reads currentJobId from a search page', () => {
    const [target] = parseLookupInput(
      'https://www.linkedin.com/jobs/search/?keywords=analyst&currentJobId=4012345678',
    );
    expect(target?.keys).toEqual(['linkedin:4012345678']);
    expect(target?.linkedinId).toBe('4012345678');
  });

  it('reads job-board URLs to keys and a posting', () => {
    const [gh, lever] = parseLookupInput(
      'https://boards.greenhouse.io/acme/jobs/123456?gh_src=x\nhttps://jobs.lever.co/acme/6f1c2d3e-aaaa-bbbb-cccc-0123456789ab',
    );
    expect(gh).toMatchObject({
      keys: ['greenhouse:123456'],
      ats: { type: 'greenhouse', token: 'acme', id: '123456' },
    });
    expect(lever?.ats).toEqual({
      type: 'lever',
      token: 'acme',
      id: '6f1c2d3e-aaaa-bbbb-cccc-0123456789ab',
    });
  });

  it('collapses repeats, strips punctuation, keeps unknown URLs and ignores junk lines', () => {
    const targets = parseLookupInput(
      [
        'see https://www.linkedin.com/jobs/view/4012345678/, and',
        'https://www.linkedin.com/jobs/view/4012345678?trk=x',
        'https://careers.example.com/jobs/42?utm_source=a',
        'not a link, just words',
        'ftp://example.com/file',
      ].join('\n'),
    );
    expect(targets.map((target) => target.url)).toEqual([
      'https://www.linkedin.com/jobs/view/4012345678',
      'https://careers.example.com/jobs/42',
    ]);
    expect(targets[1]?.keys).toEqual([]);
  });

  it('caps the number of URLs', () => {
    const many = Array.from({ length: 150 }, (_, i) => `https://example.com/j/${String(i)}`);
    expect(parseLookupInput(many.join('\n'))).toHaveLength(LOOKUP_LIMITS.urls);
  });
});

describe('parseAtsUrl', () => {
  it('recognises the four boards', () => {
    expect(parseAtsUrl('https://job-boards.greenhouse.io/acme/jobs/99')).toEqual({
      type: 'greenhouse',
      token: 'acme',
      id: '99',
    });
    expect(
      parseAtsUrl('https://jobs.eu.lever.co/acme/6f1c2d3e-aaaa-bbbb-cccc-0123456789ab')?.host,
    ).toBe('eu');
    expect(
      parseAtsUrl('https://jobs.ashbyhq.com/acme/6f1c2d3e-aaaa-bbbb-cccc-0123456789ab'),
    ).toMatchObject({ type: 'ashby', token: 'acme' });
    expect(parseAtsUrl('https://apply.workable.com/acme/j/ABC123DEF4/')).toEqual({
      type: 'workable',
      token: 'acme',
      id: 'ABC123DEF4',
    });
  });

  it('returns null for anything else', () => {
    expect(parseAtsUrl('https://careers.example.com/jobs/1')).toBeNull();
    expect(parseAtsUrl('https://boards.greenhouse.io/acme')).toBeNull();
    expect(parseAtsUrl('https://www.linkedin.com/jobs/view/4012345678')).toBeNull();
    expect(parseAtsUrl('nonsense')).toBeNull();
  });
});

describe('parseResultsPage', () => {
  const rows = parseResultsPage(resultsPageText(), resultsPageLinks());

  it('reads all 25 cards with title, company, location and age', () => {
    expect(rows).toHaveLength(25);
    expect(rows[0]).toMatchObject({
      title: 'Product Analyst',
      company: 'Acme Analytics',
      location: 'London',
      age: 'Posted 2 hours ago',
    });
    // A card with no age line, and one that shows "Viewed" instead.
    expect(rows[7]?.age).toBeUndefined();
    expect(rows[4]?.age).toBe('Posted 2 weeks ago');
    expect(rows[3]?.age).toBe('Reposted 1 week ago');
  });

  it('reads the title once, from the doubled line, with or without "(Verified job)"', () => {
    expect(rows.map((row) => row.title)).toEqual(RESULTS_CARDS.map((card) => card.title));
    expect(RESULTS_CARDS.some((card) => card.verified)).toBe(true);
    expect(RESULTS_CARDS.some((card) => !card.verified)).toBe(true);
    for (const row of rows) expect(row.title).not.toMatch(/verified|with verification/i);
  });

  it('keeps bare towns and removes the work mode from the location', () => {
    expect(rows.map((row) => row.location)).toEqual(
      RESULTS_CARDS.map((card) => card.location.replace(/ ?\((Hybrid|Remote|On-site)\)$/, '')),
    );
    expect(rows.some((row) => row.location === 'Reading')).toBe(true);
    for (const row of rows) expect(row.location).not.toMatch(/\((Hybrid|Remote|On-site)\)/);
  });

  it('reads a title with brackets of its own and a doubled age', () => {
    const [row] = parseResultsPage(
      [
        'Insights Lead (9 Month FTC) (Verified job)Insights Lead (9 Month FTC) ',
        'Example Co',
        'London (Hybrid)',
        '3 school alumni work here',
        'Posted 2 weeks ago2 weeks ago',
      ].join('\n\n'),
    );
    expect(row).toEqual({
      title: 'Insights Lead (9 Month FTC)',
      company: 'Example Co',
      location: 'London',
      age: 'Posted 2 weeks ago',
    });
  });

  it('pairs each card with its own job ID by order, even when titles repeat', () => {
    expect(rows.map((row) => row.linkedinId)).toEqual(RESULTS_CARDS.map((card) => card.id));
    expect(rows[2]?.title).toBe(rows[11]?.title);
    expect(rows[2]?.linkedinId).not.toBe(rows[11]?.linkedinId);
  });

  it('drops badges, salary, alumni and "Easy Apply" lines instead of reading them as data', () => {
    const joined = rows.map((row) => `${row.title}|${row.company}|${row.location}`).join('\n');
    for (const noise of [
      'Promoted',
      'Easy Apply',
      'alumni',
      'top applicant',
      'Viewed',
      'GBP',
      '£',
    ]) {
      expect(joined).not.toContain(noise);
    }
    expect(rows.map((row) => row.company)).toEqual(RESULTS_CARDS.map((card) => card.company));
  });

  it('reads plain text alone, with no IDs', () => {
    const plain = parseResultsPage(resultsPageText());
    expect(plain).toHaveLength(25);
    expect(plain.every((row) => row.linkedinId === undefined)).toBe(true);
    expect(plain.map((row) => row.company)).toEqual(rows.map((row) => row.company));
  });

  it('ignores links that are not job titles', () => {
    const withJunk = parseResultsPage(resultsPageText(), [
      { href: 'https://www.linkedin.com/company/acme/', text: 'Product Analyst' },
      ...resultsPageLinks(),
    ]);
    expect(withJunk[0]?.linkedinId).toBe(RESULTS_CARDS[0]?.id);
  });

  it('leaves out a card cut off at the start of the copy, and one missing its location', () => {
    const text = [
      'Product Analyst',
      'Cut Off Co',
      'Carrowby',
      'Posted 2 weeks ago2 weeks ago',
      'Data AnalystData Analyst',
      'No Location Co',
      'Posted 1 week ago1 week ago',
      'Business AnalystBusiness Analyst',
      'Whole Co',
      'Leeds',
    ].join('\n\n');
    expect(parseResultsPage(text)).toEqual([
      { title: 'Business Analyst', company: 'Whole Co', location: 'Leeds' },
    ]);
  });

  it('caps the rows at 50', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      ...(RESULTS_CARDS[i % 25] ?? RESULTS_CARDS[0]),
      id: String(5_000_000_000 + i),
    }));
    expect(parseResultsPage(resultsPageText(many as never))).toHaveLength(LOOKUP_LIMITS.rows);
  });

  it('finds nothing in text it cannot read', () => {
    expect(parseResultsPage(UNREADABLE_PASTE)).toEqual([]);
    expect(parseResultsPage('')).toEqual([]);
  });
});

describe('ageToPostedAt', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  it('turns relative ages into approximate dates', () => {
    expect(ageToPostedAt('Just now', now)).toEqual(now);
    expect(ageToPostedAt('3 days ago', now)).toEqual(new Date('2026-10-05T12:00:00Z'));
    expect(ageToPostedAt('Reposted 1 week ago', now)).toEqual(new Date('2026-10-01T12:00:00Z'));
    expect(ageToPostedAt('Posted 1 week ago1 week ago', now)).toEqual(
      new Date('2026-10-01T12:00:00Z'),
    );
    expect(ageToPostedAt('2 hours ago', now)).toEqual(new Date('2026-10-08T10:00:00Z'));
    expect(ageToPostedAt('1 month ago', now)).toEqual(new Date('2026-09-08T12:00:00Z'));
  });
  it('returns nothing for text that is not an age', () => {
    expect(ageToPostedAt('yesterday-ish', now)).toBeUndefined();
    expect(ageToPostedAt('', now)).toBeUndefined();
  });
});

describe('LookupInputSchema', () => {
  it('accepts the three actions and refuses unknown or oversized input', () => {
    const row = { kind: 'row', title: 'Analyst', company: 'Acme', location: 'London' };
    expect(LookupInputSchema.safeParse({ action: 'add', jobs: [row] }).success).toBe(true);
    expect(
      LookupInputSchema.safeParse({
        action: 'add',
        jobs: [{ kind: 'url', url: 'https://boards.greenhouse.io/a/jobs/1' }],
      }).success,
    ).toBe(true);
    expect(LookupInputSchema.safeParse({ action: 'add', jobs: [] }).success).toBe(false);
    expect(LookupInputSchema.safeParse({ action: 'add', jobs: Array(51).fill(row) }).success).toBe(
      false,
    );
    expect(
      LookupInputSchema.safeParse({ action: 'describe', jobId: 'j1', text: 'x' }).success,
    ).toBe(true);
    expect(
      LookupInputSchema.safeParse({
        action: 'describe',
        jobId: 'j1',
        text: 'x'.repeat(LOOKUP_LIMITS.description + 1),
      }).success,
    ).toBe(false);
    expect(LookupInputSchema.safeParse({ action: 'parse', text: 'abc', links: [] }).success).toBe(
      true,
    );
    expect(LookupInputSchema.safeParse({ action: 'delete' }).success).toBe(false);
    expect(
      LookupInputSchema.safeParse({
        action: 'add',
        jobs: [{ kind: 'row', title: 'a', company: 'b', location: '', linkedinId: 'abc' }],
      }).success,
    ).toBe(false);
  });
});
