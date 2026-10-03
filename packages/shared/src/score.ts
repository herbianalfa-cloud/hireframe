import { compareIds } from './candidate.js';
import { lanePoints, type CriteriaContent } from './criteria.js';
import {
  FACT_ALIAS_PATTERN,
  FUNNEL_LIMITS,
  type DeepReadOutput,
  type ExperienceAsk,
  type GapType,
  type JobDeep,
  type JobGap,
  type JobRequirement,
  type TriageLane,
  type Verdict,
} from './funnel.js';

/**
 * Code-recomputed scores and verdicts (docs/FUNNEL.md "Rubric", ADR-034). The model extracts
 * requirements and matches them to facts; code turns that into fit, luck and a verdict, so a
 * threshold or lane-points change re-scores without a model call, and injected text can't set a
 * score. The model's own scores are kept only to flag drift.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Upper headcount bound that counts as a small company for luck (`companies.size`). */
export const SMALL_COMPANY_MAX = 100;

/** Model scores this far from code's are logged for eval review (FUNNEL.md). */
export const DRIFT_THRESHOLD = 2;

// ---- Fact aliases ----

/**
 * Short names for facts in the S3 prompt (`F1`, `F2`, … in factId order), so the system prompt
 * is identical for every job in a run and the model can't garble a 20-character ID.
 */
export function factAliases(factIds: readonly string[]): {
  toAlias: Map<string, string>;
  toId: Map<string, string>;
} {
  const sorted = [...new Set(factIds)].sort(compareIds);
  const toAlias = new Map(sorted.map((id, index) => [id, `F${String(index + 1)}`]));
  const toId = new Map([...toAlias].map(([id, alias]) => [alias, id]));
  return { toAlias, toId };
}

/** The gap a requirement gets when code downgrades an unsupported match to missing. */
function downgradeGap(type: JobRequirement['type']): GapType {
  if (type === 'domain') return 'domain';
  if (type === 'seniority') return 'seniority';
  return 'tool';
}

/**
 * Maps the model's fact aliases to fact IDs and drops unknown ones. A requirement claimed `met`
 * or `partial` must cite at least one real fact; otherwise it becomes `missing` (counted), so an
 * injected "everything is met" earns nothing.
 */
export function resolveDeepRead(
  output: DeepReadOutput,
  toId: ReadonlyMap<string, string>,
): { deep: JobDeep; downgraded: number; unknownRefs: number } {
  let downgraded = 0;
  let unknownRefs = 0;
  const requirements = output.requirements.map((requirement): JobRequirement => {
    const factIds: string[] = [];
    for (const ref of requirement.factRefs) {
      const id = FACT_ALIAS_PATTERN.test(ref) ? toId.get(ref) : undefined;
      if (id === undefined) unknownRefs += 1;
      else if (!factIds.includes(id)) factIds.push(id);
    }
    if (requirement.match !== 'missing' && factIds.length === 0) {
      downgraded += 1;
      return {
        text: requirement.text,
        level: requirement.level,
        type: requirement.type,
        match: 'missing',
        gap: requirement.gap ?? downgradeGap(requirement.type),
        factIds: [],
      };
    }
    return {
      text: requirement.text,
      level: requirement.level,
      type: requirement.type,
      match: requirement.match,
      gap: requirement.match === 'met' ? null : (requirement.gap ?? downgradeGap(requirement.type)),
      factIds,
    };
  });
  return {
    deep: {
      requirements,
      rubric: output.rubric,
      employer: output.employer,
      model: { fit: output.fitScore, luck: output.luckScore, verdict: output.verdict },
      reason: output.reason,
      talkingPoints: output.talkingPoints,
    },
    downgraded,
    unknownRefs,
  };
}

// ---- Scores ----

export interface ScoreInput {
  /** The S2 lane. */
  lane: TriageLane;
  deep: JobDeep;
  criteria: CriteriaContent;
  postedAt?: Date;
  now: Date;
  /** `companies/{id}.size` when the job links to a watchlist company, e.g. "51-200". */
  companySize?: string;
  experienceAsk?: ExperienceAsk;
}

export interface ScoreResult {
  fit: number;
  luck: number;
  verdict: Verdict;
  /** Near misses only: what fell short. */
  shortfall?: string;
  gaps: JobGap[];
  matchedFactIds: string[];
  drift: boolean;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function coverage(requirements: readonly JobRequirement[], empty: number): number {
  if (requirements.length === 0) return empty;
  const points = requirements.reduce(
    (sum, r) => sum + (r.match === 'met' ? 1 : r.match === 'partial' ? 0.5 : 0),
    0,
  );
  return points / requirements.length;
}

/** The upper bound of a headcount like "51-200", "11–50 employees" or "250+"; null if unclear. */
export function companySizeMax(size: string | undefined): number | null {
  const numbers = (size ?? '').replace(/,/g, '').match(/\d+/g)?.map(Number) ?? [];
  if (numbers.length === 0) return null;
  if ((size ?? '').includes('+') && numbers.length === 1) return null;
  return Math.max(...numbers);
}

function isSmallCompany(input: ScoreInput): boolean {
  const max = companySizeMax(input.companySize);
  if (max !== null) return max <= SMALL_COMPANY_MAX;
  return input.deep.employer === 'small';
}

export function scoreJob(input: ScoreInput): ScoreResult {
  const { deep, criteria, now } = input;
  const musts = deep.requirements.filter((r) => r.level === 'must');
  const nices = deep.requirements.filter((r) => r.level === 'nice');
  const lane = input.lane === 'none' ? 0 : lanePoints(criteria)[input.lane];

  // No must-haves extracted: neutral half coverage rather than a free full score.
  let fit =
    lane +
    coverage(musts, 0.5) * 3 +
    deep.rubric.evidence +
    deep.rubric.companyFit +
    coverage(nices, 0) * 1;
  const domainBlocker = musts.some((r) => r.match === 'missing' && r.gap === 'domain');
  const hardBlocker = deep.requirements.some((r) => r.match !== 'met' && r.gap === 'hard-blocker');
  if (domainBlocker) fit = Math.min(fit, 4);
  if (hardBlocker) fit = Math.min(fit, 2);
  fit = round1(clamp(fit, 0, 10));

  let luck = fit;
  const luckNotes: string[] = [];
  if (deep.employer === 'big_brand') {
    luck -= 2;
    luckNotes.push('big employer');
  }
  if (input.postedAt) {
    const ageDays = (now.getTime() - input.postedAt.getTime()) / DAY_MS;
    if (ageDays > 7) {
      luck -= 1;
      luckNotes.push('posted over a week ago');
    } else if (ageDays <= 3) luck += 1;
  }
  if (isSmallCompany(input)) luck += 1;
  if (input.experienceAsk && input.experienceAsk.years >= criteria.experience_cap_years) {
    luck -= 2;
    luckNotes.push(`asks ${String(input.experienceAsk.years)}+ years`);
  }
  luck = round1(clamp(luck, 0, 10));

  const t = criteria.thresholds;
  let verdict: Verdict;
  if (fit >= t.apply_fit && luck >= t.apply_luck && !domainBlocker && !hardBlocker) {
    verdict = 'apply';
  } else if (input.lane === 'wildcard' && fit >= t.wildcard_fit) {
    verdict = 'wildcard';
  } else if (
    (fit >= t.near_miss_fit && fit < t.apply_fit) ||
    (fit >= t.apply_fit && luck < t.apply_luck)
  ) {
    verdict = 'near_miss';
  } else {
    verdict = 'skip';
  }

  let shortfall: string | undefined;
  if (verdict === 'near_miss') {
    if (fit >= t.apply_fit) {
      shortfall = `Luck ${String(luck)} < ${String(t.apply_luck)}${
        luckNotes.length ? `: ${luckNotes.join(', ')}` : ''
      }`;
    } else {
      const missing = musts.filter((r) => r.match !== 'met').map((r) => r.text);
      shortfall = `Fit ${String(fit)} < ${String(t.apply_fit)}${
        missing.length ? `; missing: ${missing.slice(0, 3).join('; ')}` : ''
      }`;
    }
    shortfall = shortfall.slice(0, FUNNEL_LIMITS.shortfall);
  }

  const gaps = deep.requirements
    .filter((r): r is JobRequirement & { gap: GapType } => r.match !== 'met' && r.gap !== null)
    .map((r) => ({ type: r.gap, text: r.text }))
    .slice(0, FUNNEL_LIMITS.gaps);
  const matchedFactIds = [
    ...new Set(deep.requirements.filter((r) => r.match !== 'missing').flatMap((r) => r.factIds)),
  ].slice(0, FUNNEL_LIMITS.matchedFactIds);
  const drift =
    Math.abs(deep.model.fit - fit) > DRIFT_THRESHOLD ||
    Math.abs(deep.model.luck - luck) > DRIFT_THRESHOLD;

  return { fit, luck, verdict, ...(shortfall ? { shortfall } : {}), gaps, matchedFactIds, drift };
}

/** S2's decision in code: a model "pass" with lane `none` is still a skip. */
export function triagePasses(triage: { pass: boolean; lane: TriageLane }): boolean {
  return triage.pass && triage.lane !== 'none';
}
