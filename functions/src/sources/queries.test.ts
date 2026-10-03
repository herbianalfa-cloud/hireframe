import { CRITERIA_SEED_V1 } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { QUOTAS } from '../config.js';
import {
  addCalls,
  currentQuota,
  laneQueries,
  planQueries,
  quotaPeriods,
  remainingCalls,
} from './queries.js';

describe('laneQueries', () => {
  it('lists primary titles first, expands slash alternatives and drops repeats', () => {
    const { primary, rest } = laneQueries(CRITERIA_SEED_V1);
    expect(primary[0]).toBe('Product Operations Associate');
    expect(rest).toEqual(
      expect.arrayContaining([
        'Junior Business Analyst',
        'Graduate Business Analyst',
        'Associate Business Analyst',
      ]),
    );
    const all = [...primary, ...rest].map((title) => title.toLowerCase());
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('planQueries', () => {
  const { primary, rest } = laneQueries(CRITERIA_SEED_V1);

  it('always runs the primary titles, then rotates through the rest', () => {
    const budget = primary.length + 3;
    const first = planQueries(CRITERIA_SEED_V1, budget, 0);
    expect(first.queries).toEqual([...primary, ...rest.slice(0, 3)]);
    const second = planQueries(CRITERIA_SEED_V1, budget, first.nextCursor);
    expect(second.queries.slice(primary.length)).toEqual(rest.slice(3, 6));
  });

  it('wraps around and never repeats within a run', () => {
    const plan = planQueries(CRITERIA_SEED_V1, primary.length + 2, rest.length - 1);
    expect(plan.queries.slice(primary.length)).toEqual([rest.at(-1), rest[0]]);
    expect(plan.nextCursor).toBe(1);
    const huge = planQueries(CRITERIA_SEED_V1, 1000, 0).queries;
    expect(huge).toHaveLength(primary.length + rest.length);
  });

  it('plans nothing with no budget, and only primary titles with a small one', () => {
    expect(planQueries(CRITERIA_SEED_V1, 0, 4)).toEqual({ queries: [], nextCursor: 4 });
    expect(planQueries(CRITERIA_SEED_V1, 2, 0).queries).toEqual(primary.slice(0, 2));
  });
});

describe('quotas (ADR-025)', () => {
  it('uses Europe/London calendar periods and ISO weeks', () => {
    // London is on GMT in winter, so 23:30 UTC on 31 Dec is still 31 Dec there.
    expect(quotaPeriods(new Date('2026-12-31T23:30:00Z'))).toEqual({
      day: '2026-12-31',
      week: '2026-W53',
      month: '2026-12',
    });
    // 23:30 UTC on 30 Jun is 00:30 on 1 Jul in London (BST).
    expect(quotaPeriods(new Date('2026-06-30T23:30:00Z'))).toEqual({
      day: '2026-07-01',
      week: '2026-W27',
      month: '2026-07',
    });
    expect(quotaPeriods(new Date('2027-01-04T12:00:00Z')).week).toBe('2027-W01');
  });

  it('starts new periods from zero', () => {
    const now = new Date('2026-10-02T09:00:00Z');
    const stored = {
      day: '2026-10-01',
      dayCount: 200,
      week: '2026-W40',
      weekCount: 400,
      month: '2026-10',
      monthCount: 900,
    };
    expect(currentQuota(stored, now)).toEqual({ ...stored, day: '2026-10-02', dayCount: 0 });
    expect(currentQuota(undefined, now)).toMatchObject({
      dayCount: 0,
      weekCount: 0,
      monthCount: 0,
    });
  });

  it('caps a run by the tightest remaining period', () => {
    const quota = currentQuota(undefined, new Date('2026-10-02T09:00:00Z'));
    expect(remainingCalls(quota, QUOTAS.adzuna)).toBe(20);
    expect(remainingCalls({ ...quota, dayCount: 215 }, QUOTAS.adzuna)).toBe(10);
    expect(remainingCalls({ ...quota, weekCount: 899 }, QUOTAS.adzuna)).toBe(1);
    expect(remainingCalls({ ...quota, monthCount: 2_300 }, QUOTAS.adzuna)).toBe(0);
    expect(addCalls(quota, 3)).toMatchObject({ dayCount: 3, weekCount: 3, monthCount: 3 });
  });

  it('keeps Adzuna inside its published limits with headroom', () => {
    expect(QUOTAS.adzuna.perDay).toBeLessThan(250);
    expect(QUOTAS.adzuna.perWeek).toBeLessThan(1000);
    expect(QUOTAS.adzuna.perMonth).toBeLessThan(2500);
  });
});
