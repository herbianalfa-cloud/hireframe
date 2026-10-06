import type { CompanySeed } from '@hireframe/shared';

import type { WatchedCompany } from './types.js';

/**
 * Fake API responses shaped like the real ones (checked 2026-10-01), for tests and the emulator
 * (`npm run dev` without LIVE=1). Fake companies, IDs and URLs only (CLAUDE.md: no real job
 * data, no personal data). Together with the dev seed's LinkedIn-alert job they exercise the
 * R5 merge: the Acme "Product Analyst" posting arrives from Greenhouse, Adzuna and HN.
 */

/** The emulator's watchlist seed (instead of the real one) unless LIVE=1. */
export const FAKE_SEED: readonly CompanySeed[] = [
  {
    id: 'acme-analytics',
    name: 'Acme Analytics',
    domain: 'acme-analytics.example.com',
    ats: { type: 'greenhouse', token: 'acmeanalytics' },
    hq: 'London',
  },
  {
    id: 'bramble-software',
    name: 'Bramble Software',
    domain: 'bramble.example.com',
    ats: { type: 'lever', token: 'bramble' },
    hq: 'London',
  },
  {
    id: 'cobalt-ledger',
    name: 'Cobalt Ledger',
    domain: 'cobalt-ledger.example.com',
    ats: { type: 'ashby', token: 'cobaltledger' },
    hq: 'London',
  },
  {
    id: 'delta-dock',
    name: 'Delta Dock',
    domain: 'delta-dock.example.com',
    ats: { type: 'workable', token: 'deltadock' },
    hq: 'Manchester',
  },
  // A board that no longer exists: not_found, and broken after 3 runs.
  {
    id: 'echo-gone',
    name: 'Echo Gone',
    domain: 'echo-gone.example.com',
    ats: { type: 'greenhouse', token: 'echogone' },
    hq: 'London',
  },
];

export const FAKE_WATCHLIST: readonly WatchedCompany[] = FAKE_SEED.map(({ id, name, ats }) => ({
  id,
  name,
  ats,
}));

export const GREENHOUSE_BOARD = {
  jobs: [
    {
      id: 5551234,
      title: 'Product Analyst',
      absolute_url: 'https://job-boards.greenhouse.io/acmeanalytics/jobs/5551234',
      location: { name: 'London, UK' },
      company_name: 'Acme Analytics',
      first_published: '2026-09-28T09:00:00-04:00',
      updated_at: '2026-09-29T10:00:00-04:00',
      content:
        '&lt;p&gt;Acme Analytics builds reporting tools for B2B SaaS teams.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;SQL &amp;amp; dashboards&lt;/li&gt;&lt;li&gt;Work with product managers&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;You will own the weekly metrics review, turn product questions into queries, and explain what the numbers say to the people who decide what we build next.&lt;/p&gt;',
    },
    {
      id: 5551299,
      title: 'Senior Software Engineer',
      absolute_url: 'https://job-boards.greenhouse.io/acmeanalytics/jobs/5551299',
      location: { name: 'New York, NY' },
      first_published: '2026-09-20T09:00:00-04:00',
      content: '&lt;p&gt;Build the platform.&lt;/p&gt;',
    },
    // Invalid: no title. Counted, never fatal.
    { id: 5551300, absolute_url: 'https://job-boards.greenhouse.io/acmeanalytics/jobs/5551300' },
  ],
  meta: { total: 3 },
};

export const LEVER_BOARD = [
  {
    id: '0b1c2d3e-0000-4000-8000-000000000001',
    text: 'Senior Product Analyst',
    hostedUrl: 'https://jobs.lever.co/bramble/0b1c2d3e-0000-4000-8000-000000000001',
    createdAt: 1_790_000_000_000,
    categories: { location: 'London', allLocations: ['London'] },
    description: '<div>Lead analytics for our billing product.</div>',
    lists: [{ text: 'Requirements', content: '<li>5+ years of product analytics</li>' }],
    additional: '<div>Hybrid, 3 days in the office.</div>',
    workplaceType: 'hybrid',
    country: 'GB',
  },
  {
    id: '0b1c2d3e-0000-4000-8000-000000000002',
    text: 'Junior Product Analyst',
    hostedUrl: 'https://jobs.lever.co/bramble/0b1c2d3e-0000-4000-8000-000000000002',
    createdAt: 1_790_100_000_000,
    categories: { location: 'London', allLocations: ['London'] },
    description: '<div>Join the analytics team as a graduate.</div>',
    lists: [],
    workplaceType: 'hybrid',
    country: 'GB',
    salaryRange: { min: 32000, max: 38000, currency: 'GBP', interval: 'per-year-salary' },
  },
];

export const ASHBY_BOARD = {
  apiVersion: '1',
  jobs: [
    {
      id: '7c1d0000-0000-4000-8000-0000000000aa',
      title: 'Product Analyst',
      location: 'London',
      secondaryLocations: [],
      isListed: true,
      isRemote: false,
      workplaceType: 'Hybrid',
      address: { postalAddress: { addressLocality: 'London', addressCountry: 'United Kingdom' } },
      publishedAt: '2026-09-25T10:00:00.000+00:00',
      jobUrl: 'https://jobs.ashbyhq.com/cobaltledger/7c1d0000-0000-4000-8000-0000000000aa',
      descriptionHtml: '<p>Help finance teams reconcile faster.</p>',
      compensation: {
        compensationTiers: [
          {
            components: [
              {
                compensationType: 'Salary',
                interval: '1 YEAR',
                currencyCode: 'GBP',
                minValue: 35000,
                maxValue: 42000,
              },
            ],
          },
        ],
      },
    },
    {
      id: '7c1d0000-0000-4000-8000-0000000000bb',
      title: 'Internal Transfer Only',
      location: 'London',
      isListed: false,
      jobUrl: 'https://jobs.ashbyhq.com/cobaltledger/7c1d0000-0000-4000-8000-0000000000bb',
      descriptionPlain: 'Not public.',
    },
  ],
};

export const WORKABLE_ACCOUNT = {
  name: 'Delta Dock',
  description: 'Logistics software.',
  jobs: [
    {
      title: 'Implementation Consultant',
      shortcode: 'A1B2C3D4E5',
      code: '',
      employment_type: 'Full-time',
      telecommuting: true,
      url: 'https://apply.workable.com/j/A1B2C3D4E5',
      published_on: '2026-09-27',
      created_at: '2026-09-27',
      city: 'Manchester',
      state: 'England',
      country: 'United Kingdom',
      locations: [{ city: 'Manchester', country: 'United Kingdom', hidden: false }],
      description: '<p>Onboard new customers onto our platform.</p>',
    },
  ],
};

export const REED_SEARCH = {
  results: [
    {
      jobId: 50001234,
      employerId: 1,
      employerName: 'Cobalt Ledger Limited',
      jobTitle: 'Product Analyst (Hybrid) - London',
      locationName: 'London',
      minimumSalary: 35000,
      maximumSalary: 42000,
      currency: 'GBP',
      date: '26/09/2026',
      jobDescription: 'Hybrid product analyst role in London... ',
      applications: 3,
      jobUrl: 'https://www.reed.co.uk/jobs/product-analyst-hybrid-london/50001234',
    },
    {
      jobId: 50005678,
      employerName: 'Gamma Grid Recruitment',
      jobTitle: 'Graduate Product Analyst',
      locationName: 'Leeds',
      date: '29/09/2026',
      jobDescription: 'Our client, a SaaS business in Leeds... ',
      jobUrl: 'https://www.reed.co.uk/jobs/graduate-product-analyst/50005678',
    },
  ],
  ambiguousLocations: [],
  totalResults: 2,
};

/** Reed `/api/1.0/jobs/{id}`: the full description (M4 hydration). Fake text only. */
export const REED_DETAILS = {
  jobId: 50005678,
  jobTitle: 'Graduate Product Analyst',
  jobDescription:
    '<p>Our client, a SaaS business in Leeds, is hiring a Graduate Product Analyst.</p>' +
    '<ul><li>Build dashboards in SQL and Metabase</li><li>Run user interviews with customers</li></ul>' +
    '<p>You have a degree and curiosity about how people use software.</p>',
};

export const ADZUNA_SEARCH = {
  __CLASS__: 'Adzuna::API::Response::JobSearchResults',
  count: 1,
  results: [
    {
      id: '4900000001',
      title: '<strong>Product Analyst</strong> - London - £35,000',
      description: 'Acme Analytics is looking for a <strong>Product Analyst</strong>...',
      created: '2026-09-28T13:00:00Z',
      redirect_url: 'https://www.adzuna.co.uk/jobs/land/ad/4900000001?se=x&utm_medium=api',
      company: { display_name: 'ACME ANALYTICS LTD' },
      location: { display_name: 'London, South East England', area: ['UK', 'London'] },
      salary_min: 35000,
      salary_max: 35000,
      salary_is_predicted: '0',
    },
  ],
};

export const HN_SEARCH = {
  hits: [
    { objectID: '41000000', title: 'Ask HN: Who is hiring? (October 2026)' },
    { objectID: '41000001', title: 'Ask HN: Who wants to be hired? (October 2026)' },
  ],
};

export const HN_THREAD = {
  id: 41000000,
  title: 'Ask HN: Who is hiring? (October 2026)',
  children: [
    {
      id: 41000010,
      author: 'fake-acme',
      created_at: '2026-10-01T15:05:00.000Z',
      text: 'Acme Analytics | Product Analyst | London, UK | Hybrid | Full-time<p>Apply: <a href="https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;acmeanalytics&#x2F;jobs&#x2F;5551234" rel="nofollow">https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;acmeanalytics&#x2F;jobs&#x2F;5551234</a></p>',
    },
    {
      id: 41000011,
      author: 'fake-foxglove',
      created_at: '2026-10-01T15:06:00.000Z',
      text: 'Foxglove Health | REMOTE (Europe) | Solutions Engineer | $90k-$120k<p>We build clinic software.</p>',
    },
    {
      id: 41000012,
      author: 'fake-us',
      created_at: '2026-10-01T15:07:00.000Z',
      text: 'Hollow Pine | Backend Engineer | San Francisco, CA | ONSITE<p>US only.</p>',
    },
    { id: 41000013, author: null, created_at: '2026-10-01T15:08:00.000Z', text: null },
  ],
};
