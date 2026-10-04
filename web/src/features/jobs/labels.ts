import {
  AGREEMENT_DAYS,
  AGREEMENT_TARGET,
  type Agreement,
  type GapType,
  type Job,
  type JobFlag,
  type JobStatus,
  type ReviewCode,
  type Verdict,
  type JobSkip,
} from '@hireframe/shared';
import { CircleCheck, CircleDot, CircleSlash, Sparkles, type LucideIcon } from 'lucide-react';

/** Words and icons for the job screens. Colour is never the only signal (web/DESIGN.md). */
export const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  apply: 'Apply',
  near_miss: 'Near miss',
  wildcard: 'Wildcard',
  skip: 'Skip',
};

export const VERDICT_ICONS: Readonly<Record<Verdict, LucideIcon>> = {
  apply: CircleCheck,
  near_miss: CircleDot,
  wildcard: Sparkles,
  skip: CircleSlash,
};

/** Badge colour classes per verdict, from the design tokens. */
export const VERDICT_CLASSES: Readonly<Record<Verdict, string>> = {
  apply: 'border-verdict-apply/40 bg-verdict-apply/10 text-verdict-apply',
  near_miss: 'border-verdict-near-miss/40 bg-verdict-near-miss/10 text-verdict-near-miss',
  wildcard: 'border-verdict-wildcard/40 bg-verdict-wildcard/10 text-verdict-wildcard',
  skip: 'border-verdict-skip/40 bg-verdict-skip/10 text-verdict-skip',
};

export const STATUS_LABELS: Readonly<Record<JobStatus, string>> = {
  new: 'New',
  saved: 'Saved',
  applied: 'Applied',
  skipped: 'Skipped',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
};

export const FLAG_TEXT: Readonly<Record<JobFlag, string>> = {
  freshness_unknown: 'No posting date: age counted from when it was first seen',
  experience_ambiguous: 'Years of experience asked, but unclear whether required',
  work_rights_unknown: 'Mentions right to work, and your work rights aren’t set',
  snippet_only: 'Judged from a short snippet, not the full description',
  score_drift: 'The model’s scores differed from the computed ones',
  unsupported_match: 'A claimed match had no supporting fact and was downgraded',
};

export const GAP_LABELS: Readonly<Record<GapType, string>> = {
  tool: 'Tool',
  sector: 'Sector',
  domain: 'Domain',
  seniority: 'Seniority',
  'hard-blocker': 'Hard blocker',
};

export const MATCH_LABELS = { met: 'Met', partial: 'Partial', missing: 'Missing' } as const;
export const LEVEL_LABELS = { must: 'Must have', nice: 'Nice to have' } as const;

export const REVIEW_TEXT: Readonly<Record<ReviewCode, string>> = {
  refusal: 'the model declined to answer',
  max_tokens: 'the answer was cut off',
  no_text: 'the model returned nothing',
  invalid_json: 'the answer wasn’t valid',
  schema: 'the answer didn’t match the expected shape',
  error: 'the model call kept failing',
};

export const STAGE_NAMES = { s1: 'Rules', s2: 'Triage', s3: 'Deep read' } as const;

/** Why a job was skipped, in words (PRD R6: the stage and, for rules, the rule). */
export function skipText(skip: JobSkip): string {
  const stage = STAGE_NAMES[skip.stage];
  const rule = skip.ruleId ? ` (rule ${skip.ruleId})` : '';
  return skip.note ? `${stage}${rule}: ${skip.note}` : `${stage}${rule}`;
}

/** "today", "1 day", "5 days", "3 weeks", "2 months". Uses the posting date, else first seen. */
export function ageText(job: Pick<Job, 'postedAt' | 'firstSeenAt'>, now: Date): string {
  const from = job.postedAt ?? job.firstSeenAt;
  const days = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 86_400_000));
  if (days === 0) return 'today';
  if (days === 1) return '1 day';
  if (days < 14) return `${String(days)} days`;
  if (days < 60) return `${String(Math.floor(days / 7))} weeks`;
  return `${String(Math.floor(days / 30))} months`;
}

/** "posted today", "posted 5 days ago". */
export function postedText(job: Pick<Job, 'postedAt' | 'firstSeenAt'>, now: Date): string {
  const age = ageText(job, now);
  const prefix = job.postedAt ? 'posted' : 'first seen';
  return age === 'today' ? `${prefix} today` : `${prefix} ${age} ago`;
}

export function poundsText(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

export function percentText(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

export function scoreText(value: number | undefined): string {
  return value === undefined ? '–' : value.toFixed(1);
}

export function salaryText(job: Pick<Job, 'salary'>): string | null {
  const { salary } = job;
  if (!salary || (salary.min === undefined && salary.max === undefined)) return null;
  const money = (n: number) =>
    new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: salary.currency,
      maximumFractionDigits: 0,
    }).format(n);
  const range =
    salary.min !== undefined && salary.max !== undefined && salary.min !== salary.max
      ? `${money(salary.min)}–${money(salary.max)}`
      : money(salary.max ?? salary.min ?? 0);
  return salary.period === 'unknown' ? range : `${range} per ${salary.period}`;
}

export const SOURCE_NAMES: Readonly<Record<string, string>> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workable: 'Workable',
  reed: 'Reed',
  adzuna: 'Adzuna',
  hn: 'HN Who is hiring',
  'linkedin-alert': 'LinkedIn alert',
};

/** The agreement line (ADR-038): the rate and its split, since applying is only a quiet 👍. */
export function agreementText(agreement: Agreement): string {
  if (agreement.rate === null) {
    return `No ratings yet in the last ${String(AGREEMENT_DAYS)} days. Rate a verdict 👍/👎, or mark an Apply job applied.`;
  }
  return (
    `Verdict agreement, last ${String(AGREEMENT_DAYS)} days: ${percentText(agreement.rate)} ` +
    `(target ${percentText(AGREEMENT_TARGET)}) · ${String(agreement.ratedAgree)} rated right, ` +
    `${String(agreement.ratedDisagree)} rated wrong, ${String(agreement.appliedAgree)} applied on Apply`
  );
}
