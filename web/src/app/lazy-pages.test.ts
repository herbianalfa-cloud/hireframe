import { describe, expect, it } from 'vitest';

import { loadTodayPage } from './lazy-pages';

describe('loadTodayPage', () => {
  it('returns the same import promise every time', async () => {
    const first = loadTodayPage();
    expect(loadTodayPage()).toBe(first);
    expect(await first).toHaveProperty('TodayPage');
  });
});
