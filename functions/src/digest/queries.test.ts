import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DIGEST_VERDICTS,
  digestJobsSpec,
  digestRunsSpec,
  digestSourcesSpec,
  digestWaitingSpec,
  indexServes,
  type CompositeIndex,
} from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

const { indexes } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../firestore.indexes.json', import.meta.url)), 'utf8'),
) as { indexes: CompositeIndex[] };

const SINCE = new Date('2026-10-06T06:30:00Z');

describe('digest query specs', () => {
  it.each(DIGEST_VERDICTS)(
    'serves the %s list from an index in firestore.indexes.json',
    (verdict) => {
      expect(indexServes(digestJobsSpec(verdict, SINCE), indexes)).toBe(true);
    },
  );

  it('asks for open jobs of one verdict judged since, newest judged first', () => {
    expect(digestJobsSpec('near_miss', SINCE)).toEqual({
      collection: 'jobs',
      filters: [
        { field: 'verdict', op: '==', value: 'near_miss' },
        { field: 'status', op: 'in', value: ['new', 'saved'] },
        { field: 'judgedAt', op: '>=', value: SINCE },
      ],
      orderBy: [{ field: 'judgedAt', direction: 'desc' }],
    });
  });

  it('serves the runs, waiting and sources reads without a composite index', () => {
    for (const spec of [digestRunsSpec, digestWaitingSpec, digestSourcesSpec]) {
      expect(indexServes(spec, [])).toBe(true);
    }
    expect(digestRunsSpec.orderBy).toEqual([{ field: 'startedAt', direction: 'desc' }]);
  });
});
