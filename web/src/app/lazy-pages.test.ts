import { describe, expect, it, vi } from 'vitest';

import { prefetchToday } from '@/services/dashboard';

import { loadDashboardService, loadTodayPage, startTodayPrefetch } from './lazy-pages';

vi.mock('@/services/dashboard', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prefetchToday: vi.fn(() => vi.fn()),
}));

describe('loadTodayPage', () => {
  it('returns the same import promise every time', async () => {
    const first = loadTodayPage();
    expect(loadTodayPage()).toBe(first);
    expect(await first).toHaveProperty('TodayPage');
  });
});

describe('startTodayPrefetch', () => {
  it('stops the listener it started', async () => {
    const stopListener = vi.fn();
    vi.mocked(prefetchToday).mockReturnValueOnce(stopListener);
    const stop = startTodayPrefetch();
    await vi.waitFor(() => {
      expect(prefetchToday).toHaveBeenCalledTimes(1);
    });
    stop();
    expect(stopListener).toHaveBeenCalledTimes(1);
  });

  it('never starts the listener when stopped before the import finishes', async () => {
    vi.mocked(prefetchToday).mockClear();
    startTodayPrefetch()();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prefetchToday).not.toHaveBeenCalled();
  });
});

describe('loadDashboardService', () => {
  it('returns the same import promise every time, and the prefetch uses it', async () => {
    const first = loadDashboardService();
    expect(loadDashboardService()).toBe(first);
    expect(await first).toHaveProperty('prefetchToday');
  });
});
