import { describe, expect, it } from 'vitest';

import { CRITERIA_SEED_V1 } from './criteria-seed.js';
import { TITLE_CASES } from './fixtures/title-cases.js';
import {
  checkTitle,
  laneTitleVariants,
  matchesExcludedTitle,
  SENIORITY_TITLE_IDS,
} from './titles.js';

const check = (title: string) => checkTitle(title, CRITERIA_SEED_V1);

describe('seed v1 title rules', () => {
  it.each(TITLE_CASES)('%s → %s', (title, excludedBy) => {
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

  it('uses SENIORITY_TITLE_IDS when no list is given', () => {
    const titles = [
      'Junior Brand Manager',
      'Senior Junior Brand Manager',
      'Associate Business Analyst',
      'Head of Product',
      'Plumber',
    ];
    for (const title of titles) {
      expect(checkTitle(title, CRITERIA_SEED_V1)).toEqual(
        checkTitle(title, CRITERIA_SEED_V1, SENIORITY_TITLE_IDS),
      );
    }
  });

  it('lets an explicit seniority list decide which rules a lane title cannot override', () => {
    // The seed's `manager` rule loses to the lane title by default...
    expect(check('Junior Brand Manager').excludedBy).toBeNull();
    // ...and wins once its ID is on the list,
    expect(
      checkTitle('Junior Brand Manager', CRITERIA_SEED_V1, [...SENIORITY_TITLE_IDS, 'manager'])
        .excludedBy,
    ).toBe('manager');
    // while an empty list lets the lane title beat even `senior`.
    expect(checkTitle('Senior Junior Brand Manager', CRITERIA_SEED_V1, []).excludedBy).toBeNull();
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
