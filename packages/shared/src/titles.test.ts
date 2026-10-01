import { describe, expect, it } from 'vitest';

import { CRITERIA_SEED_V1 } from './criteria-seed.js';
import { checkTitle, laneTitleVariants, matchesExcludedTitle } from './titles.js';

const check = (title: string) => checkTitle(title, CRITERIA_SEED_V1);

describe('seed v1 title rules', () => {
  it.each([
    // Asked for in the PR #4 review.
    ['Junior Brand Manager', null],
    ['Product Marketing Manager', 'manager'],
    ['Senior Product Analyst', 'senior'],
    // Business Analyst: only the listed words, immediately before the term, allow it.
    ['Business Analyst', 'business-analyst'],
    ['business analyst', 'business-analyst'],
    ['Technical Business Analyst', null],
    ['Junior Business Analyst', null],
    ['Business Analyst - Technical', 'business-analyst'],
    ['Technical Support / Business Analyst', 'business-analyst'],
    ['Senior Technical Business Analyst', 'senior'],
    ['Lead Technical Business Analyst', 'lead'],
    // Manager: "Product/Account/Associate/Junior" must come directly before it.
    ['Associate Product Manager', null],
    ['Technical Account Manager', null],
    ['Marketing Manager', 'manager'],
    ['Head of Product', 'head-of'],
    ['Data Analyst', 'data-analyst'],
    ['Product Analyst', null],
  ])('%s → %s', (title, excludedBy) => {
    expect(check(title).excludedBy).toBe(excludedBy);
  });

  it('never excludes a lane title of its own', () => {
    const laneTitles = Object.values(CRITERIA_SEED_V1.lanes).flat().flatMap(laneTitleVariants);
    expect(laneTitles.length).toBeGreaterThan(20);
    for (const title of laneTitles) expect([title, check(title).excludedBy]).toEqual([title, null]);
  });

  it('never lets a lane title override a seniority rule', () => {
    for (const prefix of ['Senior', 'Lead', 'Principal', 'Head of', 'Director,']) {
      expect(check(`${prefix} Junior Brand Manager`).excludedBy).not.toBeNull();
    }
  });

  it('reports the lane a title belongs to', () => {
    expect(check('Junior Brand Manager').lane).toBe('opportunistic');
    expect(check('Associate Business Analyst').lane).toBe('secondary');
    expect(check('Plumber').lane).toBeNull();
  });
});

describe('matchesExcludedTitle', () => {
  it('matches whole words only', () => {
    const lead = { id: 'lead', term: 'Lead' };
    expect(matchesExcludedTitle('Team Lead', lead)).toBe(true);
    expect(matchesExcludedTitle('Leading Edge Analyst', lead)).toBe(false);
  });

  it('excludes when any occurrence lacks an allowed prefix', () => {
    const manager = { id: 'manager', term: 'Manager', unless_prefixed_by: ['Product'] };
    expect(matchesExcludedTitle('Product Manager', manager)).toBe(false);
    expect(matchesExcludedTitle('Product Manager / Office Manager', manager)).toBe(true);
  });
});

describe('laneTitleVariants', () => {
  it('expands slash alternatives', () => {
    expect(laneTitleVariants('Junior/Graduate/Associate Business Analyst')).toEqual([
      'Junior Business Analyst',
      'Graduate Business Analyst',
      'Associate Business Analyst',
    ]);
    expect(laneTitleVariants('APM')).toEqual(['APM']);
  });
});
