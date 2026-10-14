import { Timestamp } from 'firebase/firestore';
import { describe, expect, it, vi } from 'vitest';

import { watchGoneBoards, watchSources, type BoardView, type SourceView } from './system';
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

describe('watchSources (ADR-057)', () => {
  const health = {
    status: 'ok',
    lastRunAt: at,
    consecutiveFailures: 0,
    lastCounts: {
      status: 'ok',
      fetched: 40,
      invalid: 0,
      new: 12,
      duplicate: 25,
      merged: 3,
      errors: 0,
      requests: 6,
      durationMs: 4000,
    },
    updatedAt: at,
    schemaVersion: 1,
  };

  function read(docs: [string, Record<string, unknown>][]) {
    let last: LiveState<SourceView[]> | undefined;
    watchSources((state) => {
      last = state;
    });
    return vi
      .waitFor(() => {
        if (!live.next) throw new Error('not subscribed');
      })
      .then(() => {
        live.next?.(snapshotOf(docs));
        if (last?.status !== 'ready') throw new Error('not ready');
        return last;
      });
  }

  it('shows a doc a wipe kept (quota, pauses) as having no scan, not as invalid', async () => {
    const kept = {
      quota: {
        day: '2026-10-14',
        dayCount: 2,
        week: '2026-W42',
        weekCount: 5,
        month: '2026-10',
        monthCount: 9,
      },
      updatedAt: at,
      schemaVersion: 1,
    };
    const state = await read([
      ['adzuna', kept],
      ['greenhouse', health],
      ['reed', { unexpected: true }],
    ]);
    expect(state.data.map((view) => [view.id, view.health === null])).toEqual([
      ['greenhouse', false],
      ['adzuna', true],
    ]);
    expect(state.invalid).toBe(1);
  });
});
