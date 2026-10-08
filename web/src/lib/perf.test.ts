import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hfMarks, markOnce, resetMarksForTest } from './perf';

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
