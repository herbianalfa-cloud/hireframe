import { laneTitleVariants, type CriteriaContent, type Quota } from '@hireframe/shared';

import type { QuotaLimits } from '../config.js';

/**
 * Search queries for the keyed job APIs (Reed, Adzuna) and their call quotas (ADR-025). Pure.
 */

/** Lane titles in priority order (slash alternatives expanded), each once, case-insensitively. */
export function laneQueries(criteria: CriteriaContent): { primary: string[]; rest: string[] } {
  const unique = (titles: readonly string[], seen: Set<string>) =>
    titles.flatMap(laneTitleVariants).filter((title) => {
      const key = title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const seen = new Set<string>();
  const primary = unique(criteria.lanes.primary, seen);
  const rest = unique([...criteria.lanes.secondary, ...criteria.lanes.opportunistic], seen);
  return { primary, rest };
}

/**
 * Primary-lane titles run every time (as many as the budget allows); the remaining budget
 * rotates through the other titles from `cursor`, so every title is searched over a few runs.
 */
export function planQueries(
  criteria: CriteriaContent,
  budget: number,
  cursor: number,
): { queries: string[]; nextCursor: number } {
  const { primary, rest } = laneQueries(criteria);
  const fromPrimary = primary.slice(0, Math.max(0, budget));
  const slots = Math.min(Math.max(0, budget - fromPrimary.length), rest.length);
  const start = rest.length === 0 ? 0 : ((cursor % rest.length) + rest.length) % rest.length;
  const rotated = Array.from({ length: slots }, (_, i) => rest[(start + i) % rest.length] ?? '');
  return {
    queries: [...fromPrimary, ...rotated],
    nextCursor: rest.length === 0 ? 0 : (start + slots) % rest.length,
  };
}

// ---- Quotas ----

function londonParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Europe/London calendar keys: `YYYY-MM-DD`, ISO week `YYYY-Www`, `YYYY-MM`. */
export function quotaPeriods(now: Date): { day: string; week: string; month: string } {
  const { year, month, day } = londonParts(now);
  // ISO week of the London calendar date: the Thursday of its week decides the year.
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const weekYear = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(weekYear, 0, 1)) / 86_400_000 + 1) / 7);
  return {
    day: `${String(year)}-${pad(month)}-${pad(day)}`,
    week: `${String(weekYear)}-W${pad(week)}`,
    month: `${String(year)}-${pad(month)}`,
  };
}

/** The counters for the current periods (a new day, week or month starts from zero). */
export function currentQuota(stored: Quota | undefined, now: Date): Quota {
  const periods = quotaPeriods(now);
  return {
    day: periods.day,
    dayCount: stored?.day === periods.day ? stored.dayCount : 0,
    week: periods.week,
    weekCount: stored?.week === periods.week ? stored.weekCount : 0,
    month: periods.month,
    monthCount: stored?.month === periods.month ? stored.monthCount : 0,
  };
}

/** Calls this run may make: the per-run budget, capped by what's left of each period. */
export function remainingCalls(quota: Quota, limits: QuotaLimits): number {
  return Math.max(
    0,
    Math.min(
      limits.perRun,
      limits.perDay - quota.dayCount,
      limits.perWeek - quota.weekCount,
      limits.perMonth - quota.monthCount,
    ),
  );
}

export function addCalls(quota: Quota, calls: number): Quota {
  return {
    ...quota,
    dayCount: quota.dayCount + calls,
    weekCount: quota.weekCount + calls,
    monthCount: quota.monthCount + calls,
  };
}
