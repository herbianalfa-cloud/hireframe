import { describe, expect, it } from 'vitest';

import {
  DeepReadOutputSchema,
  FUNNEL_JOB_FIELDS,
  JobFunnelFieldsSchema,
  TriageOutputSchema,
  type DeepReadOutput,
} from './funnel.js';
import { JobSchema } from './jobs.js';

const DEEP: DeepReadOutput = {
  requirements: [
    { text: 'SQL', level: 'must', type: 'tool', match: 'met', gap: null, factRefs: ['F1'] },
  ],
  rubric: { evidence: 1, companyFit: 0.5 },
  employer: 'other',
  fitScore: 7,
  luckScore: 6,
  verdict: 'apply',
  reason: 'Matches the product analytics work.',
  talkingPoints: ['Built a SQL dashboard'],
};

describe('model output schemas', () => {
  it('accepts a well-formed triage and deep read', () => {
    expect(
      TriageOutputSchema.safeParse({
        lane: 'primary',
        seniority: 'junior',
        blockers: [],
        pass: true,
        triageScore: 7.5,
        note: 'Product analyst, London.',
      }).success,
    ).toBe(true);
    expect(DeepReadOutputSchema.safeParse(DEEP).success).toBe(true);
  });

  it.each([
    ['a score above 10', { fitScore: 11 }],
    ['an evidence score above 2', { rubric: { evidence: 3, companyFit: 0 } }],
    ['an unknown verdict', { verdict: 'maybe' }],
    ['four talking points', { talkingPoints: ['a', 'b', 'c', 'd'] }],
    ['an empty reason', { reason: '' }],
    ['21 requirements', { requirements: Array.from({ length: 21 }, () => DEEP.requirements[0]) }],
  ])('rejects a deep read with %s', (_name, patch) => {
    expect(DeepReadOutputSchema.safeParse({ ...DEEP, ...patch }).success).toBe(false);
  });
});

describe('JobSchema funnel fields', () => {
  it('lists only optional fields, so M3 jobs still parse', () => {
    expect(FUNNEL_JOB_FIELDS).toContain('verdict');
    expect(FUNNEL_JOB_FIELDS).not.toContain('title');
    expect(JobFunnelFieldsSchema.safeParse({}).success).toBe(true);
    expect(FUNNEL_JOB_FIELDS.every((field) => field in JobSchema.shape)).toBe(true);
  });
});
