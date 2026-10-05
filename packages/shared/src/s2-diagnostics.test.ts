import { describe, expect, it } from 'vitest';

import { CRITERIA_SEED_V1 } from './criteria-seed.js';
import type { JobTriage } from './funnel.js';
import type { Job } from './jobs.js';
import {
  blockerCategory,
  buildReport,
  CANDIDATE_RULES,
  candidateRuleHits,
  isModelSkip,
  skipReasonCounts,
  type DiagnosticJob,
  type DiagnosticSets,
} from './s2-diagnostics.js';

const NOW = new Date('2026-10-05T08:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

let counter = 0;
function job(patch: Partial<Job> = {}): Job {
  counter += 1;
  return {
    dedupeKey: `d:${String(counter)}`,
    keys: [`d:${String(counter)}`],
    title: 'Product Analyst',
    company: 'Northwind Ledger',
    location: 'London',
    city: 'london',
    country: 'GB',
    remote: 'hybrid',
    url: `https://jobs.example.com/${String(counter)}`,
    sources: [
      {
        id: 'greenhouse',
        url: `https://jobs.example.com/${String(counter)}`,
        externalId: String(counter),
        seenAt: daysAgo(1),
      },
    ],
    postedAt: daysAgo(2),
    firstSeenAt: daysAgo(1),
    descriptionRef: `jobs/${String(counter)}/description/raw`,
    descriptionKind: 'full',
    stage: 's2',
    status: 'new',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    schemaVersion: 1,
    ...patch,
  };
}

const triage = (patch: Partial<JobTriage> = {}): JobTriage => ({
  lane: 'primary',
  seniority: 'junior',
  blockers: [],
  pass: false,
  triageScore: 2,
  note: 'Not a fit.',
  ...patch,
});

const skipped = (patch: Partial<Job> = {}, t: Partial<JobTriage> = {}): Job =>
  job({
    verdict: 'skip',
    skip: { stage: 's2', note: 'Not a fit.' },
    triage: triage(t),
    judgedAt: daysAgo(3),
    ...patch,
  });

const entry = (patch: Partial<Job> = {}, text = 'Help the product team.'): DiagnosticJob => ({
  job: job(patch),
  text,
});

describe('blockerCategory', () => {
  it.each([
    ['SC clearance required', 'clearance'],
    ['DV cleared', 'clearance'],
    ['Security vetting', 'clearance'],
    ['Full UK driving licence', 'licence'],
    ['Needs indefinite leave to remain', 'right_to_work'],
    ['No visa sponsorship', 'right_to_work'],
    ['Fluent German required', 'language'],
    ['Native French speaker', 'language'],
    ['5+ years experience', 'experience'],
    ['Senior-level background', 'experience'],
    ['Must be on-site five days', 'location'],
    ['Relocation to Berlin', 'location'],
    ['Wants a PhD', 'other'],
    ['', 'other'],
  ])('sorts %s as %s', (text, category) => {
    expect(blockerCategory(text)).toBe(category);
  });
});

describe('isModelSkip', () => {
  it('keeps S2 model skips and drops freshness expiries and unjudged jobs', () => {
    expect(isModelSkip(skipped())).toBe(true);
    expect(isModelSkip(skipped({ skip: { stage: 's2', ruleId: 'freshness' } }))).toBe(false);
    expect(isModelSkip(skipped({ skip: { stage: 's1', ruleId: 'title:senior' } }))).toBe(false);
    expect(isModelSkip(job({ verdict: 'skip', skip: { stage: 's2' } }))).toBe(false);
  });
});

describe('skipReasonCounts', () => {
  it('counts by lane, seniority, lane × seniority and blocker category', () => {
    const counts = skipReasonCounts([
      skipped({}, { lane: 'none', seniority: 'senior', blockers: ['6+ years experience'] }),
      skipped(
        {},
        { lane: 'none', seniority: 'senior', blockers: ['Fluent German', 'SC clearance'] },
      ),
      skipped({}, { lane: 'primary', seniority: 'mid' }),
    ]);
    expect(counts.total).toBe(3);
    expect(counts.byLane).toMatchObject({ none: 2, primary: 1, wildcard: 0 });
    expect(counts.bySeniority).toMatchObject({ senior: 2, mid: 1, junior: 0 });
    expect(counts.byLaneSeniority).toEqual({ 'none/senior': 2, 'primary/mid': 1 });
    expect(counts.byBlocker).toMatchObject({ experience: 1, language: 1, clearance: 1, other: 0 });
    expect(counts.withoutBlockers).toBe(1);
  });

  it('is all zeros for no jobs', () => {
    expect(skipReasonCounts([])).toMatchObject({ total: 0, withoutBlockers: 0 });
  });
});

describe('candidateRuleHits', () => {
  const run = (sets: Partial<DiagnosticSets>) =>
    candidateRuleHits(
      CANDIDATE_RULES,
      { s2Skipped: [], good: [], queuedS3: [], ...sets },
      CRITERIA_SEED_V1,
      'time_limited',
      NOW,
    );

  it('counts what each rule would have skipped in each set', () => {
    const hits = run({
      s2Skipped: [
        entry({ title: 'Sr Product Analyst' }),
        entry({ title: 'Software Engineer' }),
        entry({ title: 'Sales Development Representative' }),
        entry({ title: 'Product Manager' }),
        entry({ title: 'Warehouse Operative' }),
      ],
      good: [entry({ title: 'Data Engineer' })],
      queuedS3: [entry({ title: 'Account Executive' })],
    });
    expect(hits.C1).toEqual({ s2Skipped: 1, good: 0, queuedS3: 0 });
    expect(hits.C2).toEqual({ s2Skipped: 1, good: 0, queuedS3: 0 });
    expect(hits.C3).toEqual({ s2Skipped: 1, good: 1, queuedS3: 0 });
    expect(hits.C4).toEqual({ s2Skipped: 1, good: 0, queuedS3: 1 });
  });

  it('lets lane and wildcard titles survive C2 to C4', () => {
    const hits = run({
      good: [
        entry({ title: 'Junior Product Manager' }),
        entry({ title: 'Associate Product Manager' }),
        entry({ title: 'Unity Developer' }),
        entry({ title: 'Prompt Engineer' }),
        entry({ title: 'Sales Engineer' }),
        entry({ title: 'Pre-Sales Consultant' }),
        entry({ title: 'Solutions Consultant' }),
      ],
    });
    expect(hits.C2?.good).toBe(0);
    expect(hits.C3?.good).toBe(0);
    expect(hits.C4?.good).toBe(0);
  });

  it('tries C1 as a rule a lane title cannot override, like senior', () => {
    // "Product Analyst II" is a primary-lane title; the seniority marker still wins.
    expect(run({ good: [entry({ title: 'Product Analyst II' })] }).C1?.good).toBe(1);
    // Non-seniority candidates leave the lane title alone.
    expect(run({ good: [entry({ title: 'Junior Product Manager' })] }).C2?.good).toBe(0);
  });

  it('ignores a skip that is not the candidate (a freshness expiry since the job was judged)', () => {
    const old = entry({
      title: 'Warehouse Operative',
      postedAt: daysAgo(40),
      firstSeenAt: daysAgo(40),
    });
    const hits = run({ s2Skipped: [old] });
    expect(Object.values(hits).every((h) => h.s2Skipped === 0)).toBe(true);
  });

  it('replaces an existing row with the same ID instead of doubling it', () => {
    const criteria = {
      ...CRITERIA_SEED_V1,
      excluded_titles: [...CRITERIA_SEED_V1.excluded_titles, { id: 'staff', term: 'Staff' }],
    };
    const hits = candidateRuleHits(
      CANDIDATE_RULES,
      { s2Skipped: [entry({ title: 'Staff Analyst' })], good: [], queuedS3: [] },
      criteria,
      null,
      NOW,
    );
    expect(hits.C1?.s2Skipped).toBe(1);
  });
});

describe('buildReport', () => {
  const secrets = {
    title: 'Zephyr Quartz Analyst',
    company: 'Quillfeather Holdings',
    note: 'Wibble note about marmalade',
    blocker: 'Needs fluent Klingon',
  };

  function report() {
    const withSecrets = (patch: Partial<Job> = {}) =>
      skipped(
        { title: secrets.title, company: secrets.company, ...patch },
        { note: secrets.note, blockers: [secrets.blocker] },
      );
    return buildReport({
      sets: {
        s2Skipped: [
          { job: withSecrets({ judgedAt: daysAgo(20) }), text: 'zzz' },
          { job: withSecrets({ judgedAt: daysAgo(2) }), text: 'zzz' },
        ],
        good: [
          {
            job: job({
              verdict: 'apply',
              title: secrets.title,
              company: secrets.company,
              judgedAt: daysAgo(5),
            }),
            text: '',
          },
        ],
        queuedS3: [
          {
            job: job({
              next: 's3',
              sortAt: daysAgo(4),
              title: secrets.title,
              company: secrets.company,
              triage: triage({ note: secrets.note, blockers: [secrets.blocker] }),
            }),
            text: '',
          },
        ],
      },
      criteria: CRITERIA_SEED_V1,
      workRights: null,
      now: NOW,
      queuedWithoutSortAt: { s2: 0, s3: null },
    });
  }

  it('shows each set size and date range', () => {
    expect(report().sets).toEqual({
      s2Skipped: { size: 2, from: '2026-09-15', to: '2026-10-03' },
      good: { size: 1, from: '2026-09-30', to: '2026-09-30' },
      queuedS3: { size: 1, from: '2026-10-01', to: '2026-10-01' },
    });
  });

  it('holds no title, company, note, blocker or description text', () => {
    const json = JSON.stringify(report());
    for (const secret of [...Object.values(secrets), 'zzz', 'Klingon', 'Quillfeather']) {
      expect(json).not.toContain(secret);
    }
    expect(report().s2Skips.byBlocker.language).toBe(2);
  });

  it('reports an empty set as null dates', () => {
    const empty = buildReport({
      sets: { s2Skipped: [], good: [], queuedS3: [] },
      criteria: CRITERIA_SEED_V1,
      workRights: null,
      now: NOW,
      queuedWithoutSortAt: { s2: null, s3: null },
    });
    expect(empty.sets.good).toEqual({ size: 0, from: null, to: null });
  });
});
