// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { indexServes, type CompositeIndex, type QuerySpec } from './query-spec';

type Recorded =
  | { kind: 'where'; field: string; op: string; value: unknown }
  | { kind: 'orderBy'; field: string; direction: string }
  | { kind: 'limit'; count: number };

const recorded = vi.hoisted(() => ({ constraints: [] as unknown[] }));

vi.mock('./firebase', () => ({ getFirebase: () => Promise.resolve({ db: {} }) }));
vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, path: string) => ({ path }),
  query: (_ref: unknown, ...constraints: unknown[]) => {
    recorded.constraints = constraints;
    return {};
  },
  where: (field: string, op: string, value: unknown) => ({ kind: 'where', field, op, value }),
  orderBy: (field: string, direction: string) => ({ kind: 'orderBy', field, direction }),
  limit: (count: number) => ({ kind: 'limit', count }),
  startAfter: (cursor: unknown) => ({ kind: 'startAfter', cursor }),
  getDocs: () => Promise.resolve({ docs: [] }),
}));

const { JOBS_SORT_CAP, loadJobsWindow, jobFilterSpec } = await import('./jobs');

const { indexes } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../firestore.indexes.json', import.meta.url)), 'utf8'),
) as { indexes: CompositeIndex[] };

describe('loadJobsWindow (sort and filter in the browser, ADR-044)', () => {
  beforeEach(() => {
    recorded.constraints = [];
  });

  it('runs the same query shape as the paged read plus a limit, so the same indexes serve it', async () => {
    const filters = { verdict: 'near_miss', status: 'new' } as const;
    await loadJobsWindow(filters);
    const constraints = recorded.constraints as Recorded[];
    // Rebuild a spec from what was actually passed to Firestore, then check it against the indexes.
    const spec: QuerySpec = {
      collection: 'jobs',
      filters: constraints
        .filter((c): c is Extract<Recorded, { kind: 'where' }> => c.kind === 'where')
        .map(({ field, op, value }) => ({ field, op, value })) as QuerySpec['filters'],
      orderBy: constraints
        .filter((c): c is Extract<Recorded, { kind: 'orderBy' }> => c.kind === 'orderBy')
        .map(({ field, direction }) => ({ field, direction })) as QuerySpec['orderBy'],
    };
    expect(spec).toEqual(jobFilterSpec(filters));
    expect(indexServes(spec, indexes)).toBe(true);
    expect(constraints.at(-1)).toEqual({ kind: 'limit', count: JOBS_SORT_CAP });
    expect(constraints.filter((c) => c.kind === 'limit')).toHaveLength(1);
  });
});
