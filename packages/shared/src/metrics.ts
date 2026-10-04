import type { Verdict } from './funnel.js';
import type { Job } from './jobs.js';

/**
 * Dashboard numbers as pure functions (ADR-038): London calendar boundaries, verdict agreement
 * and the Today tiles. No clock reads and no Firestore: callers pass `now` and the jobs.
 */

/** Verdict agreement looks back this many days (PRD metric: ≥ 85%). */
export const AGREEMENT_DAYS = 14;
export const AGREEMENT_TARGET = 0.85;

const TIME_ZONE = 'Europe/London';

interface LondonParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

function londonParts(date: Date): LondonParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(date)
    .reduce<Record<string, number>>((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = Number(part.value);
      return acc;
    }, {});
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
  };
}

/** The instant London's calendar day `year-month-day` begins (00:00, UTC or UTC+1). */
function londonMidnight(year: number, month: number, day: number): Date {
  const utcMidnight = Date.UTC(year, month - 1, day);
  for (const candidate of [utcMidnight, utcMidnight - 3_600_000]) {
    const parts = londonParts(new Date(candidate));
    if (parts.day === day && parts.month === month && parts.hour === 0) return new Date(candidate);
  }
  return new Date(utcMidnight);
}

/** 00:00 Europe/London on the day `date` falls on. */
export function londonDayStart(date: Date): Date {
  const { year, month, day } = londonParts(date);
  return londonMidnight(year, month, day);
}

/** 00:00 Europe/London on the Monday of the week `date` falls in. */
export function londonWeekStart(date: Date): Date {
  const { year, month, day } = londonParts(date);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  const monday = new Date(Date.UTC(year, month - 1, day - ((weekday + 6) % 7)));
  return londonMidnight(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
}

// ---- Verdict agreement ----

export type AgreementJob = Pick<
  Job,
  'verdict' | 'status' | 'appliedAt' | 'appliedVerdict' | 'feedback'
>;

export interface Agreement {
  /** Explicit 👍 within the window. */
  ratedAgree: number;
  /** Explicit 👎 within the window. */
  ratedDisagree: number;
  /** Applied on an Apply verdict with no explicit rating: counts as agree. */
  appliedAgree: number;
  agree: number;
  disagree: number;
  /** agree + disagree. */
  total: number;
  /** agree / total, or null when nothing counts yet. */
  rate: number | null;
}

/**
 * ADR-038: an explicit 👍/👎 counts for or against the verdict it judged. Without one, Mark
 * applied on an Apply verdict counts as agree. Skips and no action don't count, and there is no
 * implicit disagree (a known bias: it can only lift the rate).
 */
export function verdictAgreement(
  jobs: readonly AgreementJob[],
  now: Date,
  days = AGREEMENT_DAYS,
): Agreement {
  const since = now.getTime() - days * 86_400_000;
  let ratedAgree = 0;
  let ratedDisagree = 0;
  let appliedAgree = 0;
  for (const job of jobs) {
    if (job.feedback) {
      if (job.feedback.at.getTime() < since || job.feedback.at.getTime() > now.getTime()) continue;
      if (job.feedback.agree) ratedAgree++;
      else ratedDisagree++;
    } else if (
      job.status === 'applied' &&
      job.appliedVerdict === 'apply' &&
      job.appliedAt !== undefined &&
      job.appliedAt.getTime() >= since &&
      job.appliedAt.getTime() <= now.getTime()
    ) {
      appliedAgree++;
    }
  }
  const agree = ratedAgree + appliedAgree;
  const total = agree + ratedDisagree;
  return {
    ratedAgree,
    ratedDisagree,
    appliedAgree,
    agree,
    disagree: ratedDisagree,
    total,
    rate: total === 0 ? null : agree / total,
  };
}

// ---- Today ----

export type KpiJob = Pick<Job, 'verdict' | 'status' | 'judgedAt' | 'appliedAt'>;

export interface TodayKpis {
  /** Apply verdicts still waiting for a decision (status new or saved). */
  toApply: number;
  /** Near misses and wildcards still waiting for a decision. */
  toReview: number;
  /** Non-skip verdicts judged since London midnight. */
  judgedToday: number;
  appliedThisWeek: number;
  weeklyTarget: number;
}

const OPEN_STATUSES: readonly Job['status'][] = ['new', 'saved'];

export function todayKpis(jobs: readonly KpiJob[], now: Date, weeklyTarget: number): TodayKpis {
  const dayStart = londonDayStart(now).getTime();
  const weekStart = londonWeekStart(now).getTime();
  const kpis: TodayKpis = {
    toApply: 0,
    toReview: 0,
    judgedToday: 0,
    appliedThisWeek: 0,
    weeklyTarget,
  };
  for (const job of jobs) {
    const verdict: Verdict | undefined = job.verdict;
    const open = OPEN_STATUSES.includes(job.status);
    if (verdict === 'apply' && open) kpis.toApply++;
    if ((verdict === 'near_miss' || verdict === 'wildcard') && open) kpis.toReview++;
    if (verdict && verdict !== 'skip' && job.judgedAt && job.judgedAt.getTime() >= dayStart) {
      kpis.judgedToday++;
    }
    if (job.status === 'applied' && job.appliedAt && job.appliedAt.getTime() >= weekStart) {
      kpis.appliedThisWeek++;
    }
  }
  return kpis;
}
