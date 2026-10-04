import { describe, expect, it } from 'vitest';

import {
  londonDayStart,
  londonWeekStart,
  todayKpis,
  verdictAgreement,
  type AgreementJob,
} from './metrics.js';

const NOW = new Date('2026-10-14T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

describe('London day and week boundaries', () => {
  it('starts the day at 00:00 BST in summer', () => {
    expect(londonDayStart(new Date('2026-07-15T10:00:00Z')).toISOString()).toBe(
      '2026-07-14T23:00:00.000Z',
    );
  });

  it('starts the day at 00:00 GMT in winter', () => {
    expect(londonDayStart(new Date('2026-12-15T10:00:00Z')).toISOString()).toBe(
      '2026-12-15T00:00:00.000Z',
    );
  });

  it('puts 23:30 UTC on a BST night into the next London day', () => {
    expect(londonDayStart(new Date('2026-07-15T23:30:00Z')).toISOString()).toBe(
      '2026-07-15T23:00:00.000Z',
    );
  });

  it('starts the week on Monday, across the October clock change', () => {
    // Sunday 2026-10-25 is the day the clocks go back; its week began Monday 19th at 00:00 BST.
    expect(londonWeekStart(new Date('2026-10-25T12:00:00Z')).toISOString()).toBe(
      '2026-10-18T23:00:00.000Z',
    );
    // Monday 2026-10-26 (GMT) starts a new week at 00:00 GMT.
    expect(londonWeekStart(new Date('2026-10-26T09:00:00Z')).toISOString()).toBe(
      '2026-10-26T00:00:00.000Z',
    );
  });

  it('starts the week on Monday across the March clock change', () => {
    // Clocks go forward on Sunday 2026-03-29; that week began Monday 23rd at 00:00 GMT.
    expect(londonWeekStart(new Date('2026-03-29T12:00:00Z')).toISOString()).toBe(
      '2026-03-23T00:00:00.000Z',
    );
  });
});

describe('verdictAgreement (ADR-038)', () => {
  const rated = (agree: boolean, days: number): AgreementJob => ({
    verdict: 'apply',
    status: 'new',
    feedback: { agree, verdict: 'apply', at: daysAgo(days) },
  });
  const applied = (verdict: AgreementJob['appliedVerdict'], days: number): AgreementJob => ({
    verdict: 'apply',
    status: 'applied',
    appliedAt: daysAgo(days),
    ...(verdict ? { appliedVerdict: verdict } : {}),
  });

  it('has no rate before anything counts', () => {
    const result = verdictAgreement([], NOW);
    expect(result.rate).toBeNull();
    expect(result.total).toBe(0);
  });

  it('counts ratings and applied-on-Apply, and shows the split', () => {
    const result = verdictAgreement(
      [rated(true, 1), rated(true, 2), rated(false, 3), applied('apply', 1)],
      NOW,
    );
    expect(result).toMatchObject({
      ratedAgree: 2,
      ratedDisagree: 1,
      appliedAgree: 1,
      agree: 3,
      disagree: 1,
      total: 4,
      rate: 0.75,
    });
  });

  it('does not count applying on a non-Apply verdict, skips or a missing action', () => {
    const result = verdictAgreement(
      [
        applied('near_miss', 1),
        { verdict: 'apply', status: 'skipped' },
        { verdict: 'apply', status: 'new' },
      ],
      NOW,
    );
    expect(result.total).toBe(0);
  });

  it('lets an explicit rating win over applying', () => {
    const job: AgreementJob = {
      ...applied('apply', 1),
      feedback: { agree: false, verdict: 'apply', at: daysAgo(1) },
    };
    expect(verdictAgreement([job], NOW)).toMatchObject({ ratedDisagree: 1, appliedAgree: 0 });
  });

  it('ignores anything older than the window', () => {
    expect(verdictAgreement([rated(true, 15), applied('apply', 20)], NOW).total).toBe(0);
    expect(verdictAgreement([rated(true, 13)], NOW).total).toBe(1);
    expect(verdictAgreement([rated(true, 29)], NOW, 30).total).toBe(1);
  });
});

describe('todayKpis', () => {
  it('counts open verdicts, today’s judgements and this week’s applications', () => {
    const kpis = todayKpis(
      [
        { verdict: 'apply', status: 'new', judgedAt: new Date('2026-10-14T07:40:00Z') },
        { verdict: 'apply', status: 'saved', judgedAt: daysAgo(3) },
        { verdict: 'near_miss', status: 'new', judgedAt: new Date('2026-10-14T07:41:00Z') },
        { verdict: 'skip', status: 'new', judgedAt: new Date('2026-10-14T07:42:00Z') },
        { verdict: 'apply', status: 'applied', appliedAt: new Date('2026-10-13T09:00:00Z') },
        { verdict: 'apply', status: 'applied', appliedAt: new Date('2026-10-09T09:00:00Z') },
      ],
      NOW,
      5,
    );
    expect(kpis).toEqual({
      toApply: 2,
      toReview: 1,
      judgedToday: 2,
      appliedThisWeek: 1,
      weeklyTarget: 5,
    });
  });
});
