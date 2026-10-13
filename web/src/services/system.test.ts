import { Timestamp } from 'firebase/firestore';
import { describe, expect, it, vi } from 'vitest';

import { watchGoneBoards, type BoardView } from './system';
import type { LiveState } from './profile';

/** `watchGoneBoards` lists only companies still being watched (ADR-056). */

const live = { next: undefined as ((snapshot: unknown) => void) | undefined };

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  collection: (_db: unknown, path: string) => ({ path }),
  query: (source: unknown) => source,
  where: () => ({}),
  onSnapshot: (_q: unknown, next: (snapshot: unknown) => void) => {
    live.next = next;
    return () => undefined;
  },
}));
vi.mock('./firebase', () => ({ getFirebase: () => Promise.resolve({ db: {} }) }));

const at = Timestamp.fromDate(new Date('2026-10-05T08:00:00Z'));

function company(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    domain: `${name.toLowerCase()}.example.com`,
    hq: 'London',
    origin: 'seed',
    createdAt: at,
    updatedAt: at,
    schemaVersion: 1,
    ats: { type: 'greenhouse', token: name.toLowerCase() },
    watch: true,
    lastScan: { status: 'not_found', jobs: 0, consecutiveFailures: 3, broken: true },
    lastScannedAt: at,
    ...overrides,
  };
}

const snapshotOf = (docs: [string, Record<string, unknown>][]) => ({
  docs: docs.map(([id, data]) => ({ id, data: () => data })),
});

describe('watchGoneBoards', () => {
  it('lists only watched companies, sorted by name', async () => {
    const states: LiveState<BoardView[]>[] = [];
    watchGoneBoards((state) => {
      states.push(state);
    });
    await vi.waitFor(() => {
      expect(live.next).toBeDefined();
    });
    live.next?.(
      snapshotOf([
        ['zeta', company('Zeta')],
        ['unwatched', company('Unwatched', { watch: false })],
        ['alpha', company('Alpha')],
      ]),
    );
    const last = states.at(-1);
    if (last?.status !== 'ready') throw new Error('not ready');
    expect(last.data.map((board) => board.id)).toEqual(['alpha', 'zeta']);
    expect(last.invalid).toBe(0);
  });
});
