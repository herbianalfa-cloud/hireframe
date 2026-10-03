import { describe, expect, it } from 'vitest';

import { CRITERIA_SEED_V1 } from './criteria-seed.js';
import type { CriteriaContent } from './criteria.js';
import type { WorkRights } from './profile.js';
import {
  applyHardRules,
  experienceAsks,
  isExpired,
  rightToWorkBlocks,
  type S1Input,
  type S1Job,
} from './s1.js';

const NOW = new Date('2026-10-04T08:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

const JOB: S1Job = {
  title: 'Product Analyst',
  company: 'Northwind Ledger',
  country: 'GB',
  remote: 'hybrid',
  postedAt: daysAgo(2),
  firstSeenAt: daysAgo(1),
};

type JobPatch = { [K in keyof S1Job]?: S1Job[K] | undefined };

/** The job with a patch applied; an `undefined` value removes the field. */
function jobWith(patch: JobPatch = {}): S1Job {
  const merged = Object.entries({ ...JOB, ...patch }).filter(([, value]) => value !== undefined);
  return Object.fromEntries(merged) as unknown as S1Job;
}

function run(
  overrides: { job?: JobPatch; text?: string; criteria?: Partial<CriteriaContent> } = {},
  workRights: WorkRights | null = 'time_limited',
) {
  const input: S1Input = {
    job: jobWith(overrides.job),
    text: overrides.text ?? 'Help the product team understand how customers use the app.',
    criteria: { ...CRITERIA_SEED_V1, ...overrides.criteria },
    workRights,
    now: NOW,
  };
  return applyHardRules(input);
}

const ruleOf = (result: ReturnType<typeof run>) => (result.pass ? null : result.ruleId);

describe('applyHardRules', () => {
  it('passes a plain lane job with no flags', () => {
    expect(run()).toEqual({ pass: true, flags: [], sortAt: JOB.postedAt });
  });

  it.each([
    ['Senior Product Analyst', 'title:senior'],
    ['Business Analyst', 'title:business-analyst'],
    ['Data Analyst', 'title:data-analyst'],
    ['Marketing Manager', 'title:manager'],
    ['Technical Business Analyst', null],
    ['Junior Brand Manager', null],
    // Unknown titles always reach S2, so wildcards survive.
    ['Creative Technologist', null],
    ['Unity Developer', null],
  ])('title %s → %s', (title, rule) => {
    expect(ruleOf(run({ job: { title } }))).toBe(rule);
  });

  describe('companies', () => {
    it('skips Big Four graduate schemes but not their other roles', () => {
      expect(ruleOf(run({ job: { company: 'Deloitte LLP', title: 'Graduate Scheme' } }))).toBe(
        'company',
      );
      expect(ruleOf(run({ job: { company: 'KPMG UK', title: 'Product Analyst' } }))).toBeNull();
    });

    it('skips train-and-deploy consultancies', () => {
      expect(ruleOf(run({ job: { company: 'Sparta Global', title: 'Business Analyst Trainee' } })))
        // The title rule comes first; with a lane title the company rule still applies.
        .toBe('title:business-analyst');
      expect(ruleOf(run({ job: { company: 'FDM Group', title: 'Product Analyst' } }))).toBe(
        'company',
      );
    });

    it('treats any other entry as a company name', () => {
      const criteria = { excluded_companies: ['Northwind Ledger Ltd'] };
      expect(ruleOf(run({ criteria }))).toBe('company');
    });
  });

  it('matches excluded keywords as whole words in the title or text', () => {
    const criteria = { excluded_keywords: ['commission only'] };
    expect(ruleOf(run({ criteria, text: 'This role is commission-only.' }))).toBe(
      'keyword:commission-only',
    );
    expect(ruleOf(run({ criteria, text: 'A commissioning role.' }))).toBeNull();
  });

  describe('location', () => {
    it('skips a non-UK office job', () => {
      expect(ruleOf(run({ job: { country: 'other', remote: 'onsite' } }))).toBe('location');
    });

    it('lets remote jobs elsewhere and unknown places through to S2', () => {
      expect(ruleOf(run({ job: { country: 'other', remote: 'remote' } }))).toBeNull();
      expect(ruleOf(run({ job: { country: 'unknown', remote: 'unknown' } }))).toBeNull();
    });
  });

  describe('freshness', () => {
    it('skips a posting older than freshness_days', () => {
      expect(ruleOf(run({ job: { postedAt: daysAgo(15) } }))).toBe('freshness');
      expect(ruleOf(run({ job: { postedAt: daysAgo(14) } }))).toBeNull();
    });

    it('uses the first-seen date when there is no posting date, and flags it', () => {
      const unknown = run({ job: { postedAt: undefined, firstSeenAt: daysAgo(3) } });
      expect(unknown).toMatchObject({ pass: true, flags: ['freshness_unknown'] });
      expect(unknown.sortAt).toEqual(daysAgo(3));
      expect(ruleOf(run({ job: { postedAt: undefined, firstSeenAt: daysAgo(20) } }))).toBe(
        'freshness',
      );
    });

    it('isExpired is the same check, for jobs leaving a queue', () => {
      expect(
        isExpired({ postedAt: daysAgo(15), firstSeenAt: daysAgo(1) }, { freshness_days: 14 }, NOW),
      ).toBe(true);
      expect(isExpired({ firstSeenAt: daysAgo(10) }, { freshness_days: 14 }, NOW)).toBe(false);
    });
  });

  describe('blockers', () => {
    it.each([
      ['SC clearance is required for this role.', 'blocker:sc-clearance'],
      ['You must be SC cleared or willing to undergo SC vetting.', 'blocker:sc-clearance'],
      ['Applicants need Security Check (SC) clearance.', 'blocker:sc-clearance'],
      ['This role requires DV clearance.', 'blocker:dv-clearance'],
      ['Developed Vetting is needed.', 'blocker:dv-clearance'],
      ['A full UK driving licence is essential.', 'blocker:driving-licence'],
      ['You must hold a valid driving licence.', 'blocker:driving-licence'],
      ['Driving licence required.', 'blocker:driving-licence'],
      ['We are near the station; no need for a driving licence.', null],
      ['We describe our SCSS styles and ADVs.', null],
    ])('%s → %s', (text, rule) => {
      expect(ruleOf(run({ text }))).toBe(rule);
    });

    it('finds a clearance buried deep in the text', () => {
      const text = `${'We build tools for public services. '.repeat(40)}\n\nPlease note: SC clearance is required.`;
      expect(ruleOf(run({ text }))).toBe('blocker:sc-clearance');
    });

    it('skips only blockers the criteria list', () => {
      const criteria = { blockers: ['SC clearance'] };
      expect(ruleOf(run({ criteria, text: 'Driving licence required.' }))).toBeNull();
    });

    it('matches a custom blocker label as a phrase', () => {
      const criteria = { blockers: ['night shifts'] };
      expect(ruleOf(run({ criteria, text: 'Rota includes night shifts.' }))).toBe(
        'blocker:night-shifts',
      );
    });
  });

  describe('right to work', () => {
    const INDEFINITE = 'Candidates must have indefinite leave to remain in the UK.';
    const NO_SPONSOR = 'We are unable to offer visa sponsorship for this role.';
    const HAVE_RIGHT = 'You must have the right to work in the UK.';

    it.each<[WorkRights, string, boolean]>([
      ['unrestricted', INDEFINITE, false],
      ['unrestricted', NO_SPONSOR, false],
      ['time_limited', INDEFINITE, true],
      ['time_limited', NO_SPONSOR, false],
      ['time_limited', HAVE_RIGHT, false],
      ['time_limited', 'British citizens only, due to the client contract.', true],
      ['time_limited', 'We cannot consider candidates on a Graduate visa.', true],
      ['needs_sponsorship', INDEFINITE, true],
      ['needs_sponsorship', NO_SPONSOR, true],
      ['needs_sponsorship', HAVE_RIGHT, true],
      ['needs_sponsorship', 'Sponsorship is not available.', true],
      ['needs_sponsorship', 'We can sponsor visas for the right person.', false],
    ])('%s vs "%s" → blocks %s', (rights, text, blocks) => {
      expect(rightToWorkBlocks(text, rights)).toBe(blocks);
      expect(ruleOf(run({ text }, rights))).toBe(blocks ? 'blocker:right-to-work' : null);
    });

    it('never skips on right-to-work wording before work rights are set, but flags it', () => {
      const result = run({ text: INDEFINITE }, null);
      expect(result).toMatchObject({ pass: true, flags: ['work_rights_unknown'] });
      expect(run({}, null).flags).toEqual([]);
    });

    it('is off when the criteria drop the sponsorship blocker', () => {
      const criteria = { blockers: ['SC clearance'] };
      expect(ruleOf(run({ criteria, text: INDEFINITE }))).toBeNull();
    });
  });

  describe('experience', () => {
    it.each([
      ['You have 3+ years of experience in product analytics.', 'experience'],
      ['Minimum 5 years experience required.', 'experience'],
      ['Requires 3-5 years of experience.', 'experience'],
      // Equal to the cap (2): passes and takes the luck penalty later.
      ['You have 2+ years of experience in SaaS.', null],
      ['3+ years of experience is preferred.', null],
      ['Ideally 4 years of experience in fintech.', null],
      ['We were founded 10 years ago.', null],
      ['You must be 18 years or older.', null],
    ])('%s → %s', (text, rule) => {
      expect(ruleOf(run({ text }))).toBe(rule);
    });

    it('records the highest surviving ask for the luck penalty', () => {
      const result = run({
        text: 'You have 2 years of experience in SaaS. 4 years of experience would be a plus.',
      });
      expect(result).toMatchObject({ pass: true, experienceAsk: { years: 4, required: false } });
    });

    it('passes an ambiguous ask above the cap with a flag', () => {
      const result = run({ text: '3 years experience with SQL.' });
      expect(result).toMatchObject({
        pass: true,
        flags: ['experience_ambiguous'],
        experienceAsk: { years: 3, required: false },
      });
    });

    it('records the required ask on a skip', () => {
      expect(run({ text: 'At least 4 years of experience is essential.' })).toMatchObject({
        pass: false,
        ruleId: 'experience',
        experienceAsk: { years: 4, required: true },
      });
    });

    it('reads every ask with its own sentence', () => {
      expect(
        experienceAsks('5 years experience preferred.\nYou have 1 year of experience.'),
      ).toEqual([
        { years: 5, kind: 'preferred' },
        { years: 1, kind: 'required' },
      ]);
    });
  });
});
