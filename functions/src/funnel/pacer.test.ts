import { describe, expect, it } from 'vitest';

import { createPacer } from './pacer.js';

describe('createPacer', () => {
  it('spaces starts evenly, even when called at once', async () => {
    let clock = 0;
    const starts: number[] = [];
    const pacer = createPacer(
      30,
      () => clock,
      (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    );
    for (let i = 0; i < 3; i++) {
      await pacer.wait();
      starts.push(clock);
    }
    expect(starts).toEqual([0, 2_000, 4_000]);
  });
});
