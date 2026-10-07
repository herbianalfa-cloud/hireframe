import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { indexServes, WAIT_STATES, type CompositeIndex } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { JOBS_BY_KEYS_SELECT, jobsByKeysSpec, staleQueuedSpec } from './queries.js';

const { indexes } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../firestore.indexes.json', import.meta.url)), 'utf8'),
) as { indexes: CompositeIndex[] };

const BEFORE = new Date('2026-09-21T08:00:00Z');

describe('funnel query specs', () => {
  it.each(WAIT_STATES)(
    'serves the stale %s queue from an index in firestore.indexes.json',
    (stage) => {
      expect(indexServes(staleQueuedSpec(stage, BEFORE), indexes)).toBe(true);
    },
  );

  it('asks for the stage, jobs before the cutoff, newest first', () => {
    expect(staleQueuedSpec('s3', BEFORE)).toEqual({
      collection: 'jobs',
      filters: [
        { field: 'next', op: '==', value: 's3' },
        { field: 'sortAt', op: '<', value: BEFORE },
      ],
      orderBy: [{ field: 'sortAt', direction: 'desc' }],
    });
  });

  it('serves the key lookup (array-contains-any, 30 keys) without a composite index', () => {
    const keys = Array.from({ length: 30 }, (_, index) => `k:${String(index)}`);
    const spec = jobsByKeysSpec(keys);
    expect(spec).toEqual({
      collection: 'jobs',
      filters: [{ field: 'keys', op: 'array-contains-any', value: keys }],
      orderBy: [],
    });
    expect(indexServes(spec, [])).toBe(true);
  });

  it('reads only what the dedupe and the description upgrade need', () => {
    expect([...JOBS_BY_KEYS_SELECT]).toEqual([
      'keys',
      'firstSeenAt',
      'sources',
      'descriptionKind',
      'next',
      'postedAt',
    ]);
  });
});
