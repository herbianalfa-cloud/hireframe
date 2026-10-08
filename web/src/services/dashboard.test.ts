import { DEFAULT_MONTHLY_CAP_PENCE } from '@hireframe/shared';
import { getCountFromServer, getDocs, onSnapshot } from 'firebase/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hfMarks, resetMarksForTest } from '@/lib/perf';

import {
  loadAgreement,
  loadTodayCounts,
  resolveCapPence,
  spendViewFrom,
  watchTodayList,
} from './dashboard';

vi.mock('./firebase', () => ({ getFirebase: () => Promise.resolve({ db: {} }) }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    collection: vi.fn(() => ({})),
    query: vi.fn(() => ({})),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    getDocs: vi.fn(),
    getCountFromServer: vi.fn(),
    onSnapshot: vi.fn(),
  };
});

const NOW = new Date('2026-10-14T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const doc = (id: string, data: Record<string, unknown>) => ({ id, data: () => data });

beforeEach(() => {
  vi.mocked(getDocs).mockReset();
  vi.mocked(getCountFromServer).mockReset();
  vi.mocked(onSnapshot).mockReset();
  resetMarksForTest();
});

describe('loadAgreement', () => {
  it('counts a job read by both queries once, and lets the rating win', async () => {
    const both = {
      verdict: 'apply',
      status: 'applied',
      appliedAt: daysAgo(1),
      appliedVerdict: 'apply',
      feedback: { agree: false, verdict: 'apply', at: daysAgo(1) },
    };
    vi.mocked(getDocs)
      .mockResolvedValueOnce({
        docs: [
          doc('a', both),
          doc('b', {
            verdict: 'apply',
            status: 'new',
            feedback: { agree: true, verdict: 'apply', at: daysAgo(2) },
          }),
        ],
      } as never)
      .mockResolvedValueOnce({
        docs: [
          doc('a', both),
          doc('c', {
            verdict: 'apply',
            status: 'applied',
            appliedAt: daysAgo(3),
            appliedVerdict: 'apply',
          }),
        ],
      } as never);
    const result = await loadAgreement(NOW);
    expect(result).toMatchObject({ ratedAgree: 1, ratedDisagree: 1, appliedAgree: 1, total: 3 });
  });

  it('skips documents that do not parse', async () => {
    vi.mocked(getDocs)
      .mockResolvedValueOnce({ docs: [doc('x', { status: 'sideways' })] } as never)
      .mockResolvedValueOnce({ docs: [] } as never);
    expect((await loadAgreement(NOW)).total).toBe(0);
  });
});

describe('spend meter cap', () => {
  const usage = {
    spendPence: 500,
    capPence: 1500,
    reservations: {},
    calls: {},
    tokens: {},
    byPurpose: {},
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  };

  it('prefers config/app.monthlyCapPence, then the usage cap, then the default', () => {
    expect(resolveCapPence(2000, 1500)).toBe(2000);
    expect(resolveCapPence(0, 1500)).toBe(0);
    expect(resolveCapPence(undefined, 1500)).toBe(1500);
    expect(resolveCapPence(undefined, undefined)).toBe(DEFAULT_MONTHLY_CAP_PENCE);
  });

  it('applies the configured cap to a usage document and to an untouched month', () => {
    expect(spendViewFrom(usage, 1000)?.meter).toMatchObject({ spendPence: 500, capPence: 1000 });
    expect(spendViewFrom(usage, undefined)?.meter.capPence).toBe(1500);
    expect(spendViewFrom(null, 3000)).toMatchObject({ untouched: true });
    expect(spendViewFrom(null, 3000)?.meter.capPence).toBe(3000);
    expect(spendViewFrom(null, undefined)?.meter.capPence).toBe(DEFAULT_MONTHLY_CAP_PENCE);
  });

  it('returns null for a usage document that fails its schema', () => {
    expect(spendViewFrom({ spendPence: 'lots' }, undefined)).toBeNull();
  });
});

describe('per-step marks', () => {
  it('marks each count as it settles, then all four', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(getCountFromServer).mockResolvedValue({ data: () => ({ count: 7 }) } as never);
    await loadTodayCounts(NOW);
    const names = hfMarks().map(([name]) => name);
    expect(names.slice(0, 4).sort()).toEqual([
      'hf:count:appliedThisWeek',
      'hf:count:judgedToday',
      'hf:count:toApply',
      'hf:count:toReview',
    ]);
    expect(names[4]).toBe('hf:counts');
  });

  it('marks a failed count with ok false and still marks hf:counts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(getCountFromServer).mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'permission-denied' }),
    );
    await loadTodayCounts(NOW);
    const [entry] = performance.getEntriesByName('hf:count:toApply');
    expect((entry as PerformanceMark).detail).toEqual({ ok: false });
    expect(hfMarks().map(([name]) => name)).toContain('hf:counts');
  });

  it('marks the first snapshot of a list with its size, and only the first', async () => {
    const snapshot = (docs: Record<string, unknown>[], fromCache: boolean) => ({
      size: docs.length,
      metadata: { fromCache },
      docs: docs.map((data, i) => ({ id: `j${String(i)}`, data: () => data })),
    });
    let emit: ((s: unknown) => void) | undefined;
    vi.mocked(onSnapshot).mockImplementation(((_q: unknown, next: (s: unknown) => void) => {
      emit = next;
      return () => undefined;
    }) as never);
    watchTodayList('apply', () => undefined);
    await vi.waitFor(() => {
      expect(emit).toBeDefined();
    });
    emit?.(snapshot([{ a: 1 }, { b: 22 }], true));
    emit?.(snapshot([{ a: 1 }], false));
    const entries = performance.getEntriesByName('hf:list:apply');
    expect(entries).toHaveLength(1);
    expect((entries[0] as PerformanceMark).detail).toEqual({
      docs: 2,
      fromCache: true,
      bytes: '{"a":1}'.length + '{"b":22}'.length,
    });
  });
});
