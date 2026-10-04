import { getDocs } from 'firebase/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAgreement } from './dashboard';

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
  };
});

const NOW = new Date('2026-10-14T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const doc = (id: string, data: Record<string, unknown>) => ({ id, data: () => data });

beforeEach(() => {
  vi.mocked(getDocs).mockReset();
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
