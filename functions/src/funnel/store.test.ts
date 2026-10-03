import { describe, expect, it } from 'vitest';

import { patchUpdate } from './store.js';

const NOW = new Date('2026-10-05T08:00:00Z');

describe('patchUpdate', () => {
  it('writes funnel fields, deletes cleared ones and adds cost', () => {
    const update = patchUpdate(
      { set: { verdict: 'skip', next: null, stage: 's1' }, clear: ['fitScore'], addCostPence: 0.5 },
      NOW,
    );
    expect(update).toMatchObject({ verdict: 'skip', next: null, stage: 's1', updatedAt: NOW });
    expect(update && Object.keys(update).sort()).toEqual(
      ['costPence', 'fitScore', 'next', 'stage', 'updatedAt', 'verdict'].sort(),
    );
  });

  it.each([
    ['a non-funnel field', { set: { title: 'Hacked' }, clear: [] }],
    ['clearing a non-funnel field', { set: {}, clear: ['status'] }],
    ['an invalid verdict', { set: { verdict: 'maybe' }, clear: [] }],
    ['a score above 10', { set: { fitScore: 11 }, clear: [] }],
    ['an unknown stage', { set: { stage: 's9' }, clear: [] }],
  ])('refuses %s', (_name, patch) => {
    expect(patchUpdate(patch as never, NOW)).toBeNull();
  });
});
