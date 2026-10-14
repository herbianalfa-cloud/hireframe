import { describe, expect, it } from 'vitest';

import { parseLoadTestArgs } from './args.js';

describe('parseLoadTestArgs', () => {
  it('defaults to the approved peak', () => {
    expect(parseLoadTestArgs([])).toEqual({ jobs: 1_000, s1Passes: 105 });
  });
  it('reads both options', () => {
    expect(parseLoadTestArgs(['--jobs', '500', '--s1-passes', '210'])).toEqual({
      jobs: 500,
      s1Passes: 210,
    });
  });
  it.each([
    [['--jobs']],
    [['--jobs', 'x']],
    [['--s1-passes', '0']],
    [['--bogus']],
    [['--jobs', '10', '--s1-passes', '20']],
  ])('refuses %j', (argv) => {
    expect(() => parseLoadTestArgs(argv)).toThrow();
  });
});
