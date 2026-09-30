import { describe, expect, it } from 'vitest';

import { CRITERIA_SEED_V1 } from './criteria-seed.js';
import { CRITERIA_CONTENT_KEYS, CriteriaContentSchema, criteriaVersionId } from './criteria.js';

describe('criteria seed v1', () => {
  it('parses against the schema', () => {
    expect(CriteriaContentSchema.parse(CRITERIA_SEED_V1)).toEqual(CRITERIA_SEED_V1);
  });

  it('covers every PRD R3 field with the FUNNEL.md values', () => {
    expect(CRITERIA_CONTENT_KEYS).toEqual([
      'lanes',
      'wildcards',
      'excluded_titles',
      'excluded_keywords',
      'excluded_companies',
      'experience_cap_years',
      'blockers',
      'locations',
      'company_prefs',
      'freshness_days',
      'thresholds',
      'weekly_target',
    ]);
    expect(CRITERIA_SEED_V1).toMatchObject({
      experience_cap_years: 2,
      freshness_days: 14,
      weekly_target: 10,
      thresholds: { apply_fit: 7, apply_luck: 5, near_miss_fit: 5, wildcard_fit: 6 },
      company_prefs: { size: [20, 300] },
      locations: { preferred: ['London'] },
    });
    expect(CRITERIA_SEED_V1.lanes.primary).toContain('Associate Product Manager');
  });

  it('keeps secondary-lane titles clear of the excluded-title rules', () => {
    const manager = CRITERIA_SEED_V1.excluded_titles.find((title) => title.id === 'manager');
    const analyst = CRITERIA_SEED_V1.excluded_titles.find(
      (title) => title.id === 'business-analyst',
    );
    expect(manager?.unless_prefixed_by).toEqual(['Product', 'Account', 'Associate', 'Junior']);
    expect(analyst?.unless_prefixed_by).toContain('Technical');
  });
});

describe('CriteriaContentSchema', () => {
  it.each([
    [
      'a size range with min above max',
      { company_prefs: { ...CRITERIA_SEED_V1.company_prefs, size: [300, 20] } },
    ],
    ['a threshold above 10', { thresholds: { ...CRITERIA_SEED_V1.thresholds, apply_fit: 11 } }],
    ['a fractional experience cap', { experience_cap_years: 1.5 }],
    ['an empty lane title', { lanes: { ...CRITERIA_SEED_V1.lanes, primary: [''] } }],
    ['a bad excluded title id', { excluded_titles: [{ id: 'Not OK', term: 'Senior' }] }],
  ])('rejects %s', (_name, patch) => {
    expect(CriteriaContentSchema.safeParse({ ...CRITERIA_SEED_V1, ...patch }).success).toBe(false);
  });

  it('names versions v1, v2, …', () => {
    expect(criteriaVersionId(1)).toBe('v1');
    expect(criteriaVersionId(12)).toBe('v12');
  });
});
