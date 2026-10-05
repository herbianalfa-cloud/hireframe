import { describe, expect, it } from 'vitest';

import { indexServes, type CompositeIndex, type QuerySpec } from './query-spec.js';

const index = (...fields: [string, 'ASCENDING' | 'DESCENDING'][]): CompositeIndex => ({
  collectionGroup: 'jobs',
  queryScope: 'COLLECTION',
  fields: fields.map(([fieldPath, order]) => ({ fieldPath, order })),
});

const NEXT_SORT = index(['next', 'ASCENDING'], ['sortAt', 'DESCENDING']);

const spec = (patch: Partial<QuerySpec>): QuerySpec => ({
  collection: 'jobs',
  filters: [],
  orderBy: [],
  ...patch,
});

describe('indexServes with the < range op', () => {
  const stale = (direction: 'asc' | 'desc'): QuerySpec =>
    spec({
      filters: [
        { field: 'next', op: '==', value: 's2' },
        { field: 'sortAt', op: '<', value: new Date(0) },
      ],
      orderBy: [{ field: 'sortAt', direction }],
    });

  it('treats < like >=: the range field is ordered, and the direction must match the index', () => {
    expect(indexServes(stale('desc'), [NEXT_SORT])).toBe(true);
    expect(indexServes(stale('asc'), [NEXT_SORT])).toBe(false);
  });

  it('scans a range ascending when it is not ordered, so a descending index misses', () => {
    const unordered = spec({
      filters: [
        { field: 'next', op: '==', value: 's2' },
        { field: 'sortAt', op: '<', value: new Date(0) },
      ],
    });
    expect(indexServes(unordered, [NEXT_SORT])).toBe(false);
  });

  it('requires the range field to be ordered first', () => {
    const wrongFirst = spec({
      filters: [
        { field: 'next', op: '==', value: 's2' },
        { field: 'sortAt', op: '<', value: new Date(0) },
      ],
      orderBy: [
        { field: 'triage.triageScore', direction: 'desc' },
        { field: 'sortAt', direction: 'desc' },
      ],
    });
    const withScore = index(
      ['next', 'ASCENDING'],
      ['triage.triageScore', 'DESCENDING'],
      ['sortAt', 'DESCENDING'],
    );
    expect(indexServes(wrongFirst, [withScore])).toBe(false);
  });

  it('refuses range filters on two different fields', () => {
    const two = spec({
      filters: [
        { field: 'sortAt', op: '<', value: new Date(0) },
        { field: 'judgedAt', op: '>=', value: new Date(0) },
      ],
      orderBy: [{ field: 'sortAt', direction: 'desc' }],
    });
    expect(indexServes(two, [NEXT_SORT])).toBe(false);
  });

  it('allows both bounds on one field', () => {
    const window = spec({
      filters: [
        { field: 'next', op: '==', value: 's2' },
        { field: 'sortAt', op: '>=', value: new Date(0) },
        { field: 'sortAt', op: '<', value: new Date(1) },
      ],
      orderBy: [{ field: 'sortAt', direction: 'desc' }],
    });
    expect(indexServes(window, [NEXT_SORT])).toBe(true);
  });
});
