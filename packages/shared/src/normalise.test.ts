import { describe, expect, it } from 'vitest';

import {
  canonicalUrl,
  foldText,
  keysFromUrl,
  normaliseCompany,
  normaliseTitle,
  parseLocation,
  sourceKey,
} from './normalise.js';

describe('foldText', () => {
  it('folds case, accents, ampersands and punctuation', () => {
    expect(foldText('  Café & Crème—Ltd. ')).toBe('cafe and creme ltd');
  });
});

describe('normaliseCompany', () => {
  it.each([
    ['Acme Analytics Ltd', 'acme analytics'],
    ['ACME ANALYTICS LIMITED', 'acme analytics'],
    ['Acme Analytics (UK) Ltd.', 'acme analytics'],
    ['The Access Company plc', 'access company'],
    ['Smith & Jones', 'smith and jones'],
    ['UK', 'uk'],
    ['Limited', 'limited'],
  ])('%s → %s', (name, expected) => {
    expect(normaliseCompany(name)).toBe(expected);
  });
});

describe('normaliseTitle', () => {
  it.each([
    ['Product Analyst (Hybrid) - London', 'product analyst'],
    ['Product Analyst', 'product analyst'],
    ['Product Analyst | Remote, UK', 'product analyst'],
    ['Product Analyst - London - £35,000', 'product analyst'],
    ['Product Analyst (m/f/d)', 'product analyst'],
    ['Product Analyst – 12 Month FTC', 'product analyst'],
    ['Product Analyst (Maternity Cover)', 'product analyst'],
    ['Product Analyst, Up to £40k + benefits', 'product analyst'],
    // Level words are normalised, never stripped (ADR-030).
    ['Senior Product Analyst', 'senior product analyst'],
    ['Sr. Product Analyst', 'senior product analyst'],
    ['Jr Product Analyst', 'junior product analyst'],
    ['Grad Product Analyst', 'graduate product analyst'],
    // Content that isn't noise stays.
    ['Product Analyst (Payments)', 'product analyst payments'],
    ['Product Analyst - SaaS', 'product analyst saas'],
    ['Technical Support / Business Analyst', 'technical support business analyst'],
  ])('%s → %s', (title, expected) => {
    expect(normaliseTitle(title)).toBe(expected);
  });
});

describe('parseLocation', () => {
  it.each([
    ['London, England, United Kingdom', { city: 'london', country: 'GB', remote: 'unknown' }],
    ['London, UK', { city: 'london', country: 'GB', remote: 'unknown' }],
    ['London (Hybrid)', { city: 'london', country: 'GB', remote: 'hybrid' }],
    ['Remote - UK', { city: 'remote', country: 'GB', remote: 'remote' }],
    ['Remote', { city: 'remote', country: 'unknown', remote: 'remote' }],
    ['Manchester or London', { city: 'manchester', country: 'GB', remote: 'unknown' }],
    ['Cambridge, MA', { city: 'cambridge', country: 'other', remote: 'unknown' }],
    ['London, Ontario, Canada', { city: 'london', country: 'other', remote: 'unknown' }],
    ['New York, NY', { city: 'new york', country: 'other', remote: 'unknown' }],
    ['Berlin, Germany', { city: 'berlin', country: 'other', remote: 'unknown' }],
    ['Chelmsford, Essex', { city: 'chelmsford', country: 'unknown', remote: 'unknown' }],
    ['', { city: '', country: 'unknown', remote: 'unknown' }],
    ['On-site, Bristol', { city: 'bristol', country: 'GB', remote: 'onsite' }],
  ] as const)('%s', (text, expected) => {
    expect(parseLocation(text)).toEqual(expected);
  });

  it('keeps an API remote flag unless the text says otherwise', () => {
    expect(parseLocation('London', 'remote').remote).toBe('remote');
    expect(parseLocation('London (Hybrid)', 'remote').remote).toBe('hybrid');
  });

  it('picks the city named first', () => {
    expect(parseLocation('Leeds; London').city).toBe('leeds');
  });
});

describe('canonicalUrl', () => {
  it('drops tracking, fragments and trailing slashes, and sorts the rest', () => {
    expect(canonicalUrl('http://WWW.Example.com/jobs/1/?utm_source=x&b=2&gh_src=y&a=1#apply')).toBe(
      'https://www.example.com/jobs/1?a=1&b=2',
    );
  });

  it('rejects non-http URLs and junk', () => {
    expect(canonicalUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalUrl('not a url')).toBeNull();
  });
});

describe('keysFromUrl', () => {
  it.each([
    ['https://boards.greenhouse.io/acme/jobs/5551234', ['greenhouse:5551234']],
    ['https://job-boards.eu.greenhouse.io/acme/jobs/5551234?gh_src=x', ['greenhouse:5551234']],
    ['https://acme.example.com/careers?gh_jid=5551234', ['greenhouse:5551234']],
    [
      'https://jobs.lever.co/acme/0B1C2D3E-0000-4000-8000-000000000001/apply',
      ['lever:0b1c2d3e-0000-4000-8000-000000000001'],
    ],
    [
      'https://jobs.eu.lever.co/acme/0b1c2d3e-0000-4000-8000-000000000001',
      ['lever:0b1c2d3e-0000-4000-8000-000000000001'],
    ],
    [
      'https://jobs.ashbyhq.com/acme/7c1d0000-0000-4000-8000-0000000000aa',
      ['ashby:7c1d0000-0000-4000-8000-0000000000aa'],
    ],
    ['https://apply.workable.com/acme/j/A1B2C3D4E5/', ['workable:a1b2c3d4e5']],
    [
      'https://www.linkedin.com/jobs/view/product-analyst-at-acme-4012345678/?trk=x',
      ['linkedin:4012345678'],
    ],
    ['https://www.linkedin.com/jobs/view/4012345678', ['linkedin:4012345678']],
    ['https://www.linkedin.com/comm/jobs/view/4012345678', ['linkedin:4012345678']],
    ['https://www.linkedin.com/jobs/search/?currentJobId=4012345678', ['linkedin:4012345678']],
    ['https://www.reed.co.uk/jobs/product-analyst/50001234', ['reed:50001234']],
    ['https://www.adzuna.co.uk/jobs/details/4900000001', ['adzuna:4900000001']],
    ['https://news.ycombinator.com/item?id=41000001', ['hn:41000001']],
    ['https://example.com/careers/product-analyst', []],
    ['nonsense', []],
  ])('%s', (url, expected) => {
    expect(keysFromUrl(url)).toEqual(expected);
  });
});

describe('sourceKey', () => {
  it('uses the site prefix, so a LinkedIn alert matches LinkedIn URLs', () => {
    expect(sourceKey('linkedin-alert', '4012345678')).toBe('linkedin:4012345678');
    expect(sourceKey('lever', 'ABC')).toBe('lever:abc');
  });
});
