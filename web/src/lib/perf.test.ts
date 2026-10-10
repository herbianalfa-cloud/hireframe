import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hfMarks, markOnce, resetMarksForTest, signalUsable, whenUsable } from './perf';

beforeEach(() => {
  vi.restoreAllMocks();
  resetMarksForTest();
  performance.clearMeasures();
});

describe('markOnce', () => {
  it('marks each name once per page load', () => {
    markOnce('hf:a');
    markOnce('hf:a');
    expect(performance.getEntriesByName('hf:a')).toHaveLength(1);
  });

  it('keeps the detail of the first call', () => {
    markOnce('hf:list:apply', { docs: 10 });
    markOnce('hf:list:apply', { docs: 3 });
    const [entry] = performance.getEntriesByName('hf:list:apply');
    expect((entry as PerformanceMark).detail).toEqual({ docs: 10 });
  });

  it('computes a lazy detail only for the mark that is kept', () => {
    const detail = vi.fn(() => ({ bytes: 5 }));
    markOnce('hf:b', detail);
    markOnce('hf:b', detail);
    expect(detail).toHaveBeenCalledTimes(1);
  });

  it('swallows errors from the Performance API and from a lazy detail', () => {
    vi.spyOn(performance, 'mark').mockImplementation(() => {
      throw new Error('no performance');
    });
    expect(() => {
      markOnce('hf:c');
    }).not.toThrow();
    expect(() => {
      markOnce('hf:d', () => {
        throw new Error('detail failed');
      });
    }).not.toThrow();
  });
});

describe('hfMarks', () => {
  it('lists only hf marks and the usable measure, in time order', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    performance.mark('other');
    performance.mark('hf:second', { startTime: 20 });
    performance.mark('hf:first', { startTime: 10 });
    performance.measure('hf:usable', { start: 0, end: 30 });
    expect(hfMarks()).toEqual([
      ['hf:first', 10],
      ['hf:second', 20],
      ['hf:usable', 30],
    ]);
  });
});

describe('whenUsable', () => {
  it('on Today resolves only when Today signals usable', async () => {
    vi.useFakeTimers();
    try {
      let resolved = false;
      void whenUsable(true).then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(resolved).toBe(false);
      signalUsable();
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves at once once usable has been signalled', async () => {
    signalUsable();
    await expect(whenUsable(true)).resolves.toBeUndefined();
  });

  it('elsewhere resolves at the first idle moment, or after 1.5 s without one', async () => {
    vi.useFakeTimers();
    try {
      let resolved = false;
      void whenUsable(false).then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(1_499);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('on Today still gives up after 10 s if usable never comes', async () => {
    vi.useFakeTimers();
    try {
      let resolved = false;
      void whenUsable(true).then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
