import { afterEach, describe, expect, it, vi } from 'vitest';

import { isTransient, MAX_ATTEMPTS, TimeoutError, withRetry, withTimeout } from './resilience';

const noSleep = vi.fn(() => Promise.resolve());

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  noSleep.mockClear();
});

describe('withTimeout', () => {
  it('rejects with TimeoutError when the promise is too slow', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => undefined), 1000, 'slow call');
    vi.advanceTimersByTime(1000);
    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
  });

  it('resolves with the value when fast enough', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'fast call')).resolves.toBe(7);
  });
});

describe('withRetry', () => {
  it('retries transient errors with exponential backoff, at most 3 attempts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fn = vi.fn(() =>
      Promise.reject(Object.assign(new Error('down'), { code: 'unavailable' })),
    );

    await expect(
      withRetry(fn, { label: 'test', isRetryable: isTransient, sleep: noSleep }),
    ).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(noSleep.mock.calls).toEqual([[300], [600]]);
  });

  it('does not retry non-transient errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fn = vi.fn(() =>
      Promise.reject(Object.assign(new Error('no'), { code: 'permission-denied' })),
    );

    await expect(
      withRetry(fn, { label: 'test', isRetryable: isTransient, sleep: noSleep }),
    ).rejects.toThrow('no');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns once a retry succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TimeoutError('slow'))
      .mockResolvedValueOnce('ok');

    await expect(
      withRetry(fn, { label: 'test', isRetryable: isTransient, sleep: noSleep }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
