import { describe, expect, it } from 'vitest';

import type { Firestore } from 'firebase-admin/firestore';

import { firestoreFunnelStore, patchUpdate } from './store.js';

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

describe('staleQueued', () => {
  it('queries the stage, sortAt before the cutoff, newest first, with a limit', async () => {
    const calls: unknown[][] = [];
    const query: Record<string, unknown> = {
      where: (...args: unknown[]) => {
        calls.push(['where', ...args]);
        return query;
      },
      orderBy: (...args: unknown[]) => {
        calls.push(['orderBy', ...args]);
        return query;
      },
      limit: (n: number) => {
        calls.push(['limit', n]);
        return query;
      },
      get: () => Promise.resolve({ docs: [] }),
    };
    const db = { collection: () => query } as unknown as Firestore;
    const before = new Date('2026-09-21T08:00:00Z');
    await expect(firestoreFunnelStore(db).staleQueued('s3', before, 50)).resolves.toEqual([]);
    expect(calls).toEqual([
      ['where', 'next', '==', 's3'],
      ['where', 'sortAt', '<', before],
      ['orderBy', 'sortAt', 'desc'],
      ['limit', 50],
    ]);
  });

  it('reads nothing for a zero limit', async () => {
    const db = { collection: () => ({}) } as unknown as Firestore;
    await expect(firestoreFunnelStore(db).staleQueued('s2', new Date(), 0)).resolves.toEqual([]);
  });
});
