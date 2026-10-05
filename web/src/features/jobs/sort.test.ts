import type { Job, JobTriage } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { makeView } from './fixtures';
import { filterJobs, isGapFilter, isJobSort, isLaneFilter, sortJobs } from './sort';

const at = (hour: number) => new Date(`2026-10-14T${String(hour).padStart(2, '0')}:00:00Z`);
const ids = (views: readonly { id: string }[]) => views.map((view) => view.id);
const view = (id: string, overrides: Partial<Job> = {}) => makeView(id, overrides);
const unscored = (id: string, overrides: Partial<Job> = {}) => {
  const made = makeView(id, overrides);
  delete made.job.fitScore;
  delete made.job.luckScore;
  return made;
};

describe('sortJobs', () => {
  const rows = [
    view('a', { fitScore: 9, luckScore: 2, judgedAt: at(1) }),
    view('b', { fitScore: 6, luckScore: 6, judgedAt: at(2) }),
    view('c', { fitScore: 7, luckScore: 8, judgedAt: at(3) }),
  ];

  it('best orders by fit + luck, highest first', () => {
    expect(ids(sortJobs(rows, 'best'))).toEqual(['c', 'b', 'a']);
  });

  it('best breaks a tie on fit, then newest, then id', () => {
    const tied = [
      view('x', { fitScore: 5, luckScore: 5, judgedAt: at(1) }),
      view('y', { fitScore: 6, luckScore: 4, judgedAt: at(1) }),
      view('z', { fitScore: 6, luckScore: 4, judgedAt: at(5) }),
      view('w', { fitScore: 6, luckScore: 4, judgedAt: at(5) }),
    ];
    expect(ids(sortJobs(tied, 'best'))).toEqual(['w', 'z', 'y', 'x']);
  });

  it('fit orders by fit, then luck, then newest', () => {
    const tied = [
      view('p', { fitScore: 8, luckScore: 3, judgedAt: at(1) }),
      view('q', { fitScore: 8, luckScore: 7, judgedAt: at(1) }),
      view('r', { fitScore: 9, luckScore: 1, judgedAt: at(1) }),
    ];
    expect(ids(sortJobs(tied, 'fit'))).toEqual(['r', 'q', 'p']);
  });

  it('luck orders by luck, then fit, then newest', () => {
    const tied = [
      view('p', { fitScore: 3, luckScore: 8, judgedAt: at(1) }),
      view('q', { fitScore: 7, luckScore: 8, judgedAt: at(1) }),
      view('r', { fitScore: 9, luckScore: 1, judgedAt: at(1) }),
    ];
    expect(ids(sortJobs(tied, 'luck'))).toEqual(['q', 'p', 'r']);
  });

  it('newest orders by judgedAt descending', () => {
    expect(ids(sortJobs(rows, 'newest'))).toEqual(['c', 'b', 'a']);
    const reversed = [rows[2], rows[0], rows[1]].filter((item) => item !== undefined);
    expect(ids(sortJobs(reversed, 'newest'))).toEqual(['c', 'b', 'a']);
  });

  it('puts rows without scores last, even next to a score of 0', () => {
    const mixed = [
      unscored('none', { judgedAt: at(9) }),
      view('zero', { fitScore: 0, luckScore: 0, judgedAt: at(1) }),
      view('good', { fitScore: 8, luckScore: 8, judgedAt: at(1) }),
    ];
    for (const sort of ['best', 'fit', 'luck'] as const) {
      expect(ids(sortJobs(mixed, sort)), sort).toEqual(['good', 'zero', 'none']);
    }
  });

  it('is stable and does not change its input', () => {
    const same = [
      view('b', { fitScore: 5, luckScore: 5, judgedAt: at(1) }),
      view('a', { fitScore: 5, luckScore: 5, judgedAt: at(1) }),
    ];
    const before = ids(same);
    expect(ids(sortJobs(same, 'best'))).toEqual(['a', 'b']);
    expect(ids(same)).toEqual(before);
  });
});

describe('filterJobs', () => {
  const gap = (type: 'tool' | 'sector' | 'domain' | 'seniority' | 'hard-blocker') => ({
    type,
    text: `Fake ${type} gap`,
  });
  const triage = (lane: JobTriage['lane']): JobTriage => ({
    lane,
    seniority: 'mid',
    blockers: [],
    pass: true,
    triageScore: 5,
    note: 'Fake triage note.',
  });

  it('returns everything when no filter is set', () => {
    const rows = [view('a'), view('b')];
    expect(ids(filterJobs(rows, {}))).toEqual(['a', 'b']);
  });

  it('filters by lane; jobs without triage only show with no lane filter', () => {
    const rows = [
      view('p', { triage: triage('primary') }),
      view('s', { triage: triage('secondary') }),
      view('old'),
    ];
    expect(ids(filterJobs(rows, { lane: 'primary' }))).toEqual(['p']);
    expect(ids(filterJobs(rows, {}))).toEqual(['p', 's', 'old']);
  });

  it('tool, domain and seniority match any job with at least one such gap', () => {
    const rows = [
      view('t', { gaps: [gap('tool')] }),
      view('td', { gaps: [gap('tool'), gap('domain')] }),
      view('s', { gaps: [gap('seniority')] }),
      view('none', { gaps: [] }),
    ];
    expect(ids(filterJobs(rows, { gap: 'tool' }))).toEqual(['t', 'td']);
    expect(ids(filterJobs(rows, { gap: 'domain' }))).toEqual(['td']);
    expect(ids(filterJobs(rows, { gap: 'seniority' }))).toEqual(['s']);
  });

  describe('tool only', () => {
    const match = (overrides: Partial<Job>) =>
      filterJobs([view('x', overrides)], { gap: 'tool-only' }).length === 1;

    it('matches only tool gaps', () => {
      expect(match({ gaps: [gap('tool'), gap('tool')] })).toBe(true);
    });
    it('does not match tool plus domain', () => {
      expect(match({ gaps: [gap('tool'), gap('domain')] })).toBe(false);
    });
    it('does not match no gaps', () => {
      expect(match({ gaps: [] })).toBe(false);
    });
    it('does not match only seniority', () => {
      expect(match({ gaps: [gap('seniority')] })).toBe(false);
    });
    it('does not match when gaps is absent', () => {
      expect(match({})).toBe(false);
    });
  });

  it('combines lane and gap', () => {
    const rows = [
      view('a', { triage: triage('primary'), gaps: [gap('tool')] }),
      view('b', { triage: triage('secondary'), gaps: [gap('tool')] }),
    ];
    expect(ids(filterJobs(rows, { lane: 'primary', gap: 'tool' }))).toEqual(['a']);
  });
});

describe('guards', () => {
  it('accept known values and reject the rest', () => {
    expect(isJobSort('best')).toBe(true);
    expect(isJobSort('oldest')).toBe(false);
    expect(isJobSort(null)).toBe(false);
    expect(isLaneFilter('primary')).toBe(true);
    expect(isLaneFilter('none')).toBe(false);
    expect(isGapFilter('tool-only')).toBe(true);
    expect(isGapFilter('sector')).toBe(false);
  });
});
