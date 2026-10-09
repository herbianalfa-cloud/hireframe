import type { Job } from './jobs.js';

/**
 * Dashboard numbers as pure functions (ADR-038): London calendar boundaries, verdict agreement
 * and the Today summary bar. No clock reads and no Firestore: callers pass `now` and the jobs.
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

/** What the Today summary bar counts; the web service fills it with server-side counts. */
export interface SummaryCounts {
  /** Apply verdicts still waiting for a decision (status new or saved). */
  apply: number;
  /** Near misses still waiting for a decision (status new or saved). */
  nearMiss: number;
  /** Wildcards still waiting for a decision (status new or saved). */
  wildcard: number;
  /** Jobs marked applied since Monday 00:00 London. */
  appliedThisWeek: number;
}

/** Each count, or null when that one read failed (the others still show). */
export type SummaryCountResults = { [K in keyof SummaryCounts]: number | null };

export interface Summary extends SummaryCountResults {
  weeklyTarget: number;
  /** Applications still needed this week to reach the target (never below 0); null if unknown. */
  weeklyRemaining: number | null;
  weeklyMet: boolean | null;
}

/** The bar's numbers plus how far the week is from its target. `judgedToday` moved to the digest. */
export function summaryCounts(counts: SummaryCountResults, weeklyTarget: number): Summary {
  const applied = counts.appliedThisWeek;
  return {
    ...counts,
    weeklyTarget,
    weeklyRemaining: applied === null ? null : Math.max(0, weeklyTarget - applied),
    weeklyMet: applied === null ? null : applied >= weeklyTarget,
  };
}

// ---- Spend meter ----

/** The meter turns amber at this share of the monthly cap (PRD R11). */
export const SPEND_WARN_FRACTION = 0.8;

export interface SpendMeter {
  spendPence: number;
  capPence: number;
  /** Spend over cap, 0–1 (1 when the cap is 0). */
  fraction: number;
  level: 'ok' | 'warn' | 'capped';
}

export function spendMeter(spendPence: number, capPence: number): SpendMeter {
  const fraction = capPence <= 0 ? 1 : Math.min(1, spendPence / capPence);
  const level = spendPence >= capPence ? 'capped' : fraction >= SPEND_WARN_FRACTION ? 'warn' : 'ok';
  return { spendPence, capPence, fraction, level };
}
