import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { indexServes, QUEUE_STAGES, type CompositeIndex } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { staleQueuedSpec } from './queries.js';

const { indexes } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../firestore.indexes.json', import.meta.url)), 'utf8'),
) as { indexes: CompositeIndex[] };

const BEFORE = new Date('2026-09-21T08:00:00Z');

describe('funnel query specs', () => {
  it.each(QUEUE_STAGES)(
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
});
