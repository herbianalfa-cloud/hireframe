import type { RawJob } from '../jobs.js';

/**
 * Fake RawJobs for dedupe tests (PRD R5, ADR-030). Fake companies and URLs only: no real
 * postings, no personal data (CLAUDE.md).
 */

const POSTED = new Date('2026-09-28T09:00:00Z');

export function rawJob(
  overrides: Partial<RawJob> & Pick<RawJob, 'sourceId' | 'externalId'>,
): RawJob {
  return {
    url: `https://jobs.example.com/${overrides.sourceId}/${overrides.externalId}`,
    title: 'Product Analyst',
    company: 'Acme Analytics',
    locationText: 'London, UK',
    description: { kind: 'full', format: 'text', body: 'Help the product team understand usage.' },
    postedAt: POSTED,
    ...overrides,
  };
}

/** The R5 acceptance case: a LinkedIn alert and the Greenhouse listing of the same role. */
export const LINKEDIN_ALERT_JOB = rawJob({
  sourceId: 'linkedin-alert',
  externalId: '4012345678',
  url: 'https://www.linkedin.com/jobs/view/product-analyst-at-acme-analytics-4012345678/?trk=eml-alert',
  title: 'Product Analyst',
  company: 'Acme Analytics Ltd',
  locationText: 'London, England, United Kingdom',
  description: {
    kind: 'snippet',
    format: 'text',
    body: 'Acme Analytics is hiring a Product Analyst.',
  },
});

export const GREENHOUSE_JOB = rawJob({
  sourceId: 'greenhouse',
  externalId: '5551234',
  companyId: 'acme-analytics',
  url: 'https://job-boards.greenhouse.io/acmeanalytics/jobs/5551234?gh_src=abc',
  title: 'Product Analyst',
  company: 'Acme Analytics',
  locationText: 'London, UK',
  description: {
    kind: 'full',
    format: 'html',
    body: '<p>Join Acme Analytics.</p><ul><li>SQL</li><li>Dashboards</li></ul>',
  },
});

/** Same company and city, different levels: must stay two jobs. */
export const SENIOR_JOB = rawJob({
  sourceId: 'lever',
  externalId: '0b1c2d3e-0000-4000-8000-000000000001',
  title: 'Senior Product Analyst',
  company: 'Bramble Software',
});
export const JUNIOR_JOB = rawJob({
  sourceId: 'lever',
  externalId: '0b1c2d3e-0000-4000-8000-000000000002',
  title: 'Junior Product Analyst',
  company: 'Bramble Software',
});

/** Noise in the title only: must merge. */
export const NOISY_TITLE_JOB = rawJob({
  sourceId: 'reed',
  externalId: '50001234',
  url: 'https://www.reed.co.uk/jobs/product-analyst-hybrid-london/50001234',
  title: 'Product Analyst (Hybrid) - London',
  company: 'Cobalt Ledger Limited',
  locationText: 'London',
  description: { kind: 'snippet', format: 'text', body: 'Hybrid role in London.' },
});
export const PLAIN_TITLE_JOB = rawJob({
  sourceId: 'ashby',
  externalId: '7c1d0000-0000-4000-8000-0000000000aa',
  title: 'Product Analyst',
  company: 'Cobalt Ledger',
  locationText: 'London, England',
});

/** Same role, another city: stays separate. */
export const OTHER_CITY_JOB = rawJob({
  sourceId: 'workable',
  externalId: 'a1b2c3d4e5',
  title: 'Product Analyst',
  company: 'Acme Analytics',
  locationText: 'Manchester, UK',
});

/** Aggregator title with salary noise: merges with the Greenhouse job. */
export const ADZUNA_SALARY_JOB = rawJob({
  sourceId: 'adzuna',
  externalId: '4900000001',
  url: 'https://www.adzuna.co.uk/jobs/details/4900000001?utm_medium=api',
  title: 'Product Analyst - London - £35,000',
  company: 'ACME ANALYTICS LTD',
  locationText: 'London, South East England',
  description: { kind: 'snippet', format: 'text', body: 'Product Analyst at a SaaS company.' },
});

/** An HN comment for a different title that links the Greenhouse posting: merges by URL key. */
export const HN_LINKING_JOB = rawJob({
  sourceId: 'hn',
  externalId: '41000001',
  url: 'https://news.ycombinator.com/item?id=41000001',
  title: 'Analysts',
  company: 'Acme',
  locationText: 'London (hybrid)',
  description: {
    kind: 'full',
    format: 'html',
    body: 'Acme | Analysts | London<p>Apply below.</p>',
  },
  extraUrls: ['https://boards.greenhouse.io/acmeanalytics/jobs/5551234'],
});
