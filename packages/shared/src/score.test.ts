import { describe, expect, it } from 'vitest';

import { CRITERIA_SEED_V1 } from './criteria-seed.js';
import type { DeepReadOutput, JobDeep, JobRequirement } from './funnel.js';
import {
  companySizeMax,
  factAliases,
  resolveDeepRead,
  scoreJob,
  triagePasses,
  type ScoreInput,
} from './score.js';

const NOW = new Date('2026-10-04T08:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

const req = (overrides: Partial<JobRequirement> = {}): JobRequirement => ({
  text: 'SQL',
  level: 'must',
  type: 'tool',
  match: 'met',
  gap: null,
  factIds: ['fact-a'],
  ...overrides,
});

function deep(overrides: Partial<JobDeep> = {}): JobDeep {
  return {
    requirements: [req(), req({ text: 'Stakeholder communication', type: 'skill' })],
    rubric: { evidence: 1.5, companyFit: 0.5 },
    employer: 'other',
    model: { fit: 8, luck: 7, verdict: 'apply' },
    reason: 'Strong product analytics match.',
    talkingPoints: [],
    ...overrides,
  };
}

type ScorePatch = { [K in keyof ScoreInput]?: ScoreInput[K] | undefined };

/** Scores with a patch applied; an `undefined` value removes the field. */
function score(overrides: ScorePatch = {}) {
  const merged = Object.entries({
    lane: 'primary',
    deep: deep(),
    criteria: CRITERIA_SEED_V1,
    postedAt: daysAgo(5),
    now: NOW,
    ...overrides,
  }).filter(([, value]) => value !== undefined);
  return scoreJob(Object.fromEntries(merged) as unknown as ScoreInput);
}

describe('scoreJob', () => {
  it('adds lane, must coverage, evidence, company fit and nice-to-haves', () => {
    // 3 lane + 3 musts + 1.5 evidence + 0.5 company + 0 nice = 8; luck unchanged at 5 days old.
    expect(score()).toMatchObject({ fit: 8, luck: 8, verdict: 'apply', drift: false });
  });

  it('gives half coverage when no must-haves were extracted', () => {
    const result = score({ deep: deep({ requirements: [] }) });
    expect(result.fit).toBe(3 + 1.5 + 1.5 + 0.5);
  });

  it('counts partial matches as half and nice-to-haves up to 1', () => {
    const requirements = [
      req(),
      req({ match: 'partial', gap: 'tool' }),
      req({ level: 'nice', text: 'Python' }),
      req({ level: 'nice', text: 'dbt', match: 'missing', gap: 'tool', factIds: [] }),
    ];
    expect(score({ deep: deep({ requirements }) }).fit).toBe(7.8); // 3 + 2.25 + 1.5 + 0.5 + 0.5 = 7.75, rounded to one decimal
  });

  it('caps fit at 6.9 on any missing must-have, naming it in the shortfall', () => {
    const requirements = [
      req(),
      req({ text: 'Looker', match: 'missing', gap: 'tool', factIds: [] }),
    ];
    const rich = deep({ requirements, rubric: { evidence: 2, companyFit: 1 } });
    const result = score({ deep: rich });
    expect(result).toMatchObject({ fit: 6.9, verdict: 'near_miss' });
    expect(result.shortfall).toContain('missing: Looker');
  });

  it('caps fit at 4 on a missing domain must-have', () => {
    const domain = [req(), req({ type: 'domain', match: 'missing', gap: 'domain', factIds: [] })];
    expect(score({ deep: deep({ requirements: domain }) })).toMatchObject({
      fit: 4,
      verdict: 'skip',
    });
    // A domain gap on a nice-to-have doesn't cap.
    const nice = [req(), req({ level: 'nice', match: 'missing', gap: 'domain', factIds: [] })];
    expect(score({ deep: deep({ requirements: nice }) }).fit).toBe(8);
  });

  it('caps fit at 2 only when a hard blocker matches a criteria blocker in code', () => {
    const blocker = (text: string) => [
      req(),
      req({ text, type: 'credential', match: 'missing', gap: 'hard-blocker', factIds: [] }),
    ];
    expect(score({ deep: deep({ requirements: blocker('SC clearance required') }) }).fit).toBe(2);
    // The model calling a portfolio a hard blocker isn't enough: it's just a missing must
    // (3 lane + 1.5 coverage + 1.5 evidence + 0.5 company = 6.5, under the 6.9 cap).
    expect(score({ deep: deep({ requirements: blocker('A design portfolio') }) }).fit).toBe(6.5);
  });

  describe('luck', () => {
    it.each([
      ['a big brand', { deep: deep({ employer: 'big_brand' }) }, 6],
      ['posted over a week ago', { postedAt: daysAgo(8) }, 7],
      ['posted in the last 3 days', { postedAt: daysAgo(2) }, 9],
      ['a small company by headcount', { companySize: '11-50' }, 9],
      ['a small company by the model', { deep: deep({ employer: 'small' }) }, 9],
      [
        'a large company by headcount beats the model',
        { companySize: '1001-5000', deep: deep({ employer: 'small' }) },
        8,
      ],
      ['no posting date', { postedAt: undefined }, 8],
    ] as const)('%s', (_name, overrides: ScorePatch, luck) => {
      expect(score(overrides).luck).toBe(luck);
    });

    it.each([
      ['a required ask equal to the cap', { years: 2, required: true }, 6],
      ['a preferred ask equal to the cap', { years: 2, required: false }, 6],
      ['a preferred ask above the cap', { years: 4, required: false }, 6],
      ['an ask below the cap', { years: 1, required: true }, 8],
    ] as const)('takes −2 for %s', (_name, experienceAsk, luck) => {
      expect(score({ experienceAsk }).luck).toBe(luck);
    });

    it('stays within 0–10', () => {
      const low = score({
        deep: deep({
          employer: 'big_brand',
          requirements: [req({ match: 'missing', gap: 'hard-blocker', factIds: [] })],
        }),
        postedAt: daysAgo(10),
        experienceAsk: { years: 2, required: true },
      });
      expect(low.luck).toBe(0);
    });
  });

  describe('verdicts', () => {
    it.each([
      ['a big employer', { deep: deep({ employer: 'big_brand' }) }, 'big employer'],
      [
        'an experience ask at the cap',
        { experienceAsk: { years: 2, required: false } },
        'asks 2+ years',
      ],
    ] as const)(
      'holds a would-be apply at near miss for %s',
      (_name, overrides: ScorePatch, note) => {
        const result = score({ ...overrides, postedAt: daysAgo(1) });
        expect(result.luck).toBeGreaterThanOrEqual(5);
        expect(result.verdict).toBe('near_miss');
        expect(result.shortfall).toBe(`Luck held back: ${note}`);
      },
    );

    it('is a near miss with high fit and low luck, naming the luck shortfall', () => {
      const result = score({
        deep: deep({ employer: 'big_brand' }),
        postedAt: daysAgo(9),
        experienceAsk: { years: 2, required: true },
      });
      expect(result).toMatchObject({ fit: 8, luck: 3, verdict: 'near_miss' });
      expect(result.shortfall).toBe(
        'Luck 3 < 5: big employer, posted over a week ago, asks 2+ years',
      );
    });

    it('is a near miss on fit 5–6.9, naming the missing must-haves', () => {
      const requirements = [
        req(),
        req({ text: 'Looker', match: 'missing', gap: 'tool', factIds: [] }),
      ];
      const result = score({ lane: 'secondary', deep: deep({ requirements }) });
      expect(result).toMatchObject({ fit: 5.5, verdict: 'near_miss' });
      expect(result.shortfall).toBe('Fit 5.5 < 7; missing: Looker');
    });

    it('prefers wildcard over near miss for a wildcard-lane job (FUNNEL precedence)', () => {
      const requirements = [req(), req({ text: 'Unity', match: 'partial', gap: 'tool' })];
      // 2 lane + 2.25 + 1.5 + 0.5 = 6.25 → 6.3
      expect(score({ lane: 'wildcard', deep: deep({ requirements }) })).toMatchObject({
        fit: 6.3,
        verdict: 'wildcard',
      });
    });

    it('makes wildcard reachable only with wildcard lane points', () => {
      const zero = {
        ...CRITERIA_SEED_V1,
        lane_points: { primary: 3, secondary: 2, opportunistic: 1, wildcard: 0 },
      };
      const requirements = [req(), req({ text: 'Unity', match: 'partial', gap: 'tool' })];
      expect(
        score({ lane: 'wildcard', criteria: zero, deep: deep({ requirements }) }).verdict,
      ).toBe('skip');
    });

    it('applies the thresholds from criteria', () => {
      const strict = {
        ...CRITERIA_SEED_V1,
        thresholds: { ...CRITERIA_SEED_V1.thresholds, apply_fit: 9 },
      };
      expect(score({ criteria: strict }).verdict).toBe('near_miss');
    });

    it('never applies with a domain or hard blocker', () => {
      const lenient = {
        ...CRITERIA_SEED_V1,
        thresholds: { apply_fit: 1, apply_luck: 0, near_miss_fit: 0, wildcard_fit: 6 },
      };
      const requirements = [
        req(),
        req({ type: 'domain', match: 'missing', gap: 'domain', factIds: [] }),
      ];
      expect(score({ criteria: lenient, deep: deep({ requirements }) }).verdict).not.toBe('apply');
    });

    it('skips everything else', () => {
      const requirements = [req({ match: 'missing', gap: 'tool', factIds: [] })];
      expect(
        score({
          lane: 'opportunistic',
          deep: deep({ requirements, rubric: { evidence: 0, companyFit: 0 } }),
        }).verdict,
      ).toBe('skip');
    });
  });

  it('derives gaps and matched facts from the requirements', () => {
    const requirements = [
      req({ factIds: ['a', 'b'] }),
      req({ match: 'partial', gap: 'tool', factIds: ['b', 'c'] }),
      req({ text: 'Payments', type: 'domain', match: 'missing', gap: 'domain', factIds: [] }),
    ];
    expect(score({ deep: deep({ requirements }) })).toMatchObject({
      gaps: [
        { type: 'tool', text: 'SQL' },
        { type: 'domain', text: 'Payments' },
      ],
      matchedFactIds: ['a', 'b', 'c'],
    });
  });

  it('flags drift when model scores differ by more than 2', () => {
    expect(score({ deep: deep({ model: { fit: 10, luck: 10, verdict: 'apply' } }) }).drift).toBe(
      false,
    );
    expect(score({ deep: deep({ model: { fit: 4, luck: 8, verdict: 'apply' } }) }).drift).toBe(
      true,
    );
  });
});

describe('factAliases and resolveDeepRead', () => {
  const { toAlias, toId } = factAliases(['zeta', 'Alpha', 'beta', 'beta']);

  it('names facts F1… in code-unit ID order', () => {
    expect([...toAlias]).toEqual([
      ['Alpha', 'F1'],
      ['beta', 'F2'],
      ['zeta', 'F3'],
    ]);
  });

  const output = (requirements: DeepReadOutput['requirements']): DeepReadOutput => ({
    requirements,
    rubric: { evidence: 1, companyFit: 1 },
    employer: 'small',
    fitScore: 9,
    luckScore: 9,
    verdict: 'apply',
    reason: 'Good fit.',
    talkingPoints: ['Led onboarding'],
  });

  it('maps aliases to IDs and drops unknown ones', () => {
    const { deep: result, unknownRefs } = resolveDeepRead(
      output([
        {
          text: 'SQL',
          level: 'must',
          type: 'tool',
          match: 'met',
          gap: null,
          factRefs: ['F3', 'F9', 'Alpha', 'F3'],
        },
      ]),
      toId,
    );
    expect(result.requirements[0]?.factIds).toEqual(['zeta']);
    expect(unknownRefs).toBe(2);
    expect(result.model).toEqual({ fit: 9, luck: 9, verdict: 'apply' });
  });

  it('downgrades met or partial claims without a real fact to missing', () => {
    const { deep: result, downgraded } = resolveDeepRead(
      output([
        { text: 'Payments', level: 'must', type: 'domain', match: 'met', gap: null, factRefs: [] },
        {
          text: 'Looker',
          level: 'must',
          type: 'tool',
          match: 'partial',
          gap: null,
          factRefs: ['F42'],
        },
        { text: 'SQL', level: 'must', type: 'tool', match: 'met', gap: 'tool', factRefs: ['F1'] },
      ]),
      toId,
    );
    expect(downgraded).toBe(2);
    expect(result.requirements.map((r) => [r.match, r.gap])).toEqual([
      ['missing', 'domain'],
      ['missing', 'tool'],
      ['met', null],
    ]);
  });
});

describe('companySizeMax', () => {
  it.each([
    ['51-200', 200],
    ['11–50 employees', 50],
    ['1,001-5,000', 5000],
    ['250+', null],
    ['', null],
    [undefined, null],
  ])('%s → %s', (size, max) => {
    expect(companySizeMax(size)).toBe(max);
  });
});

describe('triagePasses', () => {
  it('needs a pass and a lane', () => {
    expect(triagePasses({ pass: true, lane: 'secondary' })).toBe(true);
    expect(triagePasses({ pass: true, lane: 'none' })).toBe(false);
    expect(triagePasses({ pass: false, lane: 'primary' })).toBe(false);
  });
});
