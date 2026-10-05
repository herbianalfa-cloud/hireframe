import type { CriteriaContent, ExcludedTitle } from './criteria.js';
import { SENIORITIES, TRIAGE_LANES, type TriageLane } from './funnel.js';
import type { Job } from './jobs.js';
import type { WorkRights } from './profile.js';
import { applyHardRules, BLOCKER_PATTERNS } from './s1.js';
import { SENIORITY_TITLE_IDS } from './titles.js';

/**
 * Counting for the System screen's "S2 skip reasons" panel (docs/plans/funnel-intake-plan.md,
 * ADR-043). Pure: it takes jobs and their text and returns numbers, so it is tested with fake
 * jobs and never touches the network. Everything in a report is a count, a rule ID, an enum
 * value, a category name or a date: no title, company, note or blocker text ever leaves here, so
 * the report can be pasted into a chat.
 */

type Seniority = (typeof SENIORITIES)[number];

export const BLOCKER_CATEGORIES = [
  'experience',
  'clearance',
  'licence',
  'right_to_work',
  'location',
  'language',
  'other',
] as const;
export type BlockerCategory = (typeof BLOCKER_CATEGORIES)[number];

const LICENCE = /\b(?:licen[cs]e|driving|driver)\b/i;
const CLEARANCE = /\b(?:clearance|cleared|vetting|vetted|security check)\b/i;
const RIGHT_TO_WORK =
  /\b(?:right to work|work permit|work authori[sz]ation|sponsor(?:ship|ing)?|visa|settled status|ILR|citizens?|nationality)\b/i;
const LANGUAGE =
  /\b(?:fluent|fluency|native|bilingual|multilingual|language|german|french|spanish|dutch|italian|portuguese|mandarin|cantonese|arabic|japanese|korean|polish|swedish|danish|norwegian|russian)\b/i;
const LOCATION =
  /\b(?:on-?site|in the office|office|relocat\w*|commut\w*|located|location|based in|travel|hybrid|remote)\b/i;
const EXPERIENCE = /\b(?:years?|yrs?|experience|experienced|senior|seniority|track record)\b/i;

/**
 * Which kind of blocker a model's short blocker text is. It reuses S1's own patterns where they
 * exist (SC, DV, driving licence, right to work) and falls back to looser wording; the text itself
 * is never kept.
 */
export function blockerCategory(text: string): BlockerCategory {
  if (BLOCKER_PATTERNS.sc.test(text) || BLOCKER_PATTERNS.dv.test(text) || CLEARANCE.test(text)) {
    return 'clearance';
  }
  if (BLOCKER_PATTERNS.driving.test(text) || LICENCE.test(text)) return 'licence';
  if (BLOCKER_PATTERNS.rightToWork.test(text) || RIGHT_TO_WORK.test(text)) return 'right_to_work';
  if (LANGUAGE.test(text)) return 'language';
  if (LOCATION.test(text)) return 'location';
  if (EXPERIENCE.test(text)) return 'experience';
  return 'other';
}

/** A job with its description text, as the panel loads them. */
export interface DiagnosticJob {
  job: Job;
  text: string;
}

/** The model's own S2 skips: triaged, and not an S1 or freshness rule skip. */
export function isModelSkip(job: Job): boolean {
  return job.triage !== undefined && job.skip?.stage === 's2' && job.skip.ruleId === undefined;
}

type Counts<K extends string> = Record<K, number>;

function zero<K extends string>(keys: readonly K[]): Counts<K> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Counts<K>;
}

export interface SkipReasonCounts {
  total: number;
  byLane: Counts<TriageLane>;
  bySeniority: Counts<Seniority>;
  /** Keyed `lane/seniority`; only pairs that occur. */
  byLaneSeniority: Record<string, number>;
  /** One count per blocker the model listed. */
  byBlocker: Counts<BlockerCategory>;
  /** Skips where the model listed no blocker at all. */
  withoutBlockers: number;
}

/** Counts the S2 skips by lane, seniority, lane × seniority and blocker category. */
export function skipReasonCounts(jobs: readonly Job[]): SkipReasonCounts {
  const counts: SkipReasonCounts = {
    total: 0,
    byLane: zero(TRIAGE_LANES),
    bySeniority: zero(SENIORITIES),
    byLaneSeniority: {},
    byBlocker: zero(BLOCKER_CATEGORIES),
    withoutBlockers: 0,
  };
  for (const { triage } of jobs) {
    if (!triage) continue;
    counts.total += 1;
    counts.byLane[triage.lane] += 1;
    counts.bySeniority[triage.seniority] += 1;
    const pair = `${triage.lane}/${triage.seniority}`;
    counts.byLaneSeniority[pair] = (counts.byLaneSeniority[pair] ?? 0) + 1;
    if (triage.blockers.length === 0) counts.withoutBlockers += 1;
    for (const blocker of triage.blockers) counts.byBlocker[blockerCategory(blocker)] += 1;
  }
  return counts;
}

// ---- Candidate S1 rules ----

/** A proposed S1 change that only edits criteria data (excluded title rows). */
export interface CandidateRule {
  id: string;
  /** Excluded-title rows the candidate adds. Their IDs are what the S1 skip names. */
  terms: readonly ExcludedTitle[];
  /** Whether a lane title can never override it, like `senior` (the plan's C1). */
  seniority: boolean;
}

const row = (term: string, unlessPrefixedBy?: readonly string[]): ExcludedTitle => ({
  id: term
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, ''),
  term,
  ...(unlessPrefixedBy ? { unless_prefixed_by: [...unlessPrefixedBy] } : {}),
});

/**
 * The plan's criteria-only candidates, C1 to C4. C5 (a language blocker) and C6 (an ambiguous
 * experience ask) change S1's code, so they can't be tried through `applyHardRules` yet; the
 * panel's blocker-category counts are the evidence for them.
 */
export const CANDIDATE_RULES: readonly CandidateRule[] = [
  {
    id: 'C1',
    seniority: true,
    terms: ['Sr', 'Snr', 'Mid', 'Mid Level', 'Experienced', 'Staff', 'II', 'III'].map((term) =>
      row(term),
    ),
  },
  {
    id: 'C2',
    seniority: false,
    terms: [row('Product Manager', ['Associate', 'Junior', 'Graduate', 'Trainee'])],
  },
  {
    id: 'C3',
    seniority: false,
    terms: [
      row('Software Engineer'),
      row('Data Engineer'),
      row('DevOps'),
      row('Data Scientist'),
      row('Developer', ['Unity', 'Game']),
    ],
  },
  {
    id: 'C4',
    seniority: false,
    terms: [
      'Sales Executive',
      'Sales Representative',
      'Sales Development',
      'Sales Associate',
      'Account Executive',
      'Business Development',
      'SDR',
      'BDR',
    ].map((term) => row(term)),
  },
];

export interface DiagnosticSets {
  /** The model's S2 skips (see `isModelSkip`). */
  s2Skipped: readonly DiagnosticJob[];
  /** Apply, near miss and wildcard verdicts. */
  good: readonly DiagnosticJob[];
  /** Jobs S2 passed that wait for S3. */
  queuedS3: readonly DiagnosticJob[];
}

export type SetName = keyof DiagnosticSets;
export type RuleHits = Record<SetName, number>;

/**
 * For each candidate: how many jobs in each set it would have skipped at S1. Each job runs
 * through the real `applyHardRules` with the criteria plus that one candidate, and counts only if
 * the skip is the candidate's own title rule (so a freshness expiry since the job was judged
 * doesn't count). A seniority candidate is tried as a rule lane titles can't override.
 */
export function candidateRuleHits(
  candidates: readonly CandidateRule[],
  sets: DiagnosticSets,
  criteria: CriteriaContent,
  workRights: WorkRights | null,
  now: Date,
): Record<string, RuleHits> {
  const hits: Record<string, RuleHits> = {};
  for (const candidate of candidates) {
    const ids = new Set(candidate.terms.map((term) => term.id));
    const changed: CriteriaContent = {
      ...criteria,
      excluded_titles: [
        ...criteria.excluded_titles.filter((existing) => !ids.has(existing.id)),
        ...candidate.terms,
      ],
    };
    const seniorityTitleIds = candidate.seniority
      ? [...SENIORITY_TITLE_IDS, ...ids]
      : SENIORITY_TITLE_IDS;
    const count = (jobs: readonly DiagnosticJob[]): number =>
      jobs.filter(({ job, text }) => {
        const result = applyHardRules({
          job,
          text,
          criteria: changed,
          workRights,
          now,
          seniorityTitleIds,
        });
        return !result.pass && [...ids].some((id) => result.ruleId === `title:${id}`);
      }).length;
    hits[candidate.id] = {
      s2Skipped: count(sets.s2Skipped),
      good: count(sets.good),
      queuedS3: count(sets.queuedS3),
    };
  }
  return hits;
}

// ---- The report ----

export interface SetInfo {
  size: number;
  /** Oldest and newest date in the set (`YYYY-MM-DD`), or null when empty. */
  from: string | null;
  to: string | null;
}

export function setInfo(jobs: readonly Job[], dateOf: (job: Job) => Date | undefined): SetInfo {
  const times = jobs.flatMap((job) => dateOf(job)?.getTime() ?? []);
  if (times.length === 0) return { size: jobs.length, from: null, to: null };
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { size: jobs.length, from: day(Math.min(...times)), to: day(Math.max(...times)) };
}

/** What "Copy counts" copies: numbers, rule IDs, enum values and category names only. */
export interface DiagnosticsReport {
  sets: Record<SetName, SetInfo>;
  s2Skips: SkipReasonCounts;
  candidateHits: Record<string, RuleHits>;
  /** Queued jobs an `orderBy('sortAt')` can't see (the sweep and the stages never read them). */
  queuedWithoutSortAt: { s2: number | null; s3: number | null };
}

export function buildReport(input: {
  sets: DiagnosticSets;
  criteria: CriteriaContent;
  workRights: WorkRights | null;
  now: Date;
  queuedWithoutSortAt: DiagnosticsReport['queuedWithoutSortAt'];
}): DiagnosticsReport {
  const { sets } = input;
  const jobsOf = (list: readonly DiagnosticJob[]) => list.map((entry) => entry.job);
  return {
    sets: {
      s2Skipped: setInfo(jobsOf(sets.s2Skipped), (job) => job.judgedAt),
      good: setInfo(jobsOf(sets.good), (job) => job.judgedAt),
      queuedS3: setInfo(jobsOf(sets.queuedS3), (job) => job.sortAt),
    },
    s2Skips: skipReasonCounts(jobsOf(sets.s2Skipped)),
    candidateHits: candidateRuleHits(
      CANDIDATE_RULES,
      sets,
      input.criteria,
      input.workRights,
      input.now,
    ),
    queuedWithoutSortAt: input.queuedWithoutSortAt,
  };
}
