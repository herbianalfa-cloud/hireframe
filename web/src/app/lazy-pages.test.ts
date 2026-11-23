import { describe, expect, it, vi } from 'vitest';

import { prefetchToday } from '@/services/dashboard';

import {
  loadDashboardService,
  loadedTodayPage,
  loadTodayPage,
  retryableOnce,
  startTodayPrefetch,
} from './lazy-pages';

vi.mock('@/services/dashboard', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prefetchToday: vi.fn(() => vi.fn()),
}));

describe('retryableOnce', () => {
  it('imports once while the import works', async () => {
    const load = vi.fn(() => Promise.resolve('chunk'));
    const get = retryableOnce(load);
    const first = get();
    expect(get()).toBe(first);
    expect(await first).toBe('chunk');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed import, so the next call tries again', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('chunk is gone'))
      .mockResolvedValueOnce('chunk');
    const get = retryableOnce(load);
    await expect(get()).rejects.toThrow('chunk is gone');
    expect(await get()).toBe('chunk');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('still rejects for every caller that was waiting on the failed import', async () => {
    const get = retryableOnce(() => Promise.reject(new Error('offline')));
    const first = get();
    const second = get();
    expect(second).toBe(first);
    await expect(first).rejects.toThrow('offline');
  });
});

describe('loadTodayPage', () => {
  it('returns the same import promise every time', async () => {
    const first = loadTodayPage();
    expect(loadTodayPage()).toBe(first);
    expect(await first).toHaveProperty('TodayPage');
  });

  it('exposes the module once the chunk has loaded', async () => {
    const module = await loadTodayPage();
    expect(loadedTodayPage()).toBe(module);
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
    await vi.dynamicImportSettled();
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
