// @vitest-environment node
import { Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';

import {
  diagnosticsErrorMessage,
  diagnosticsSpecs,
  IndexBuildingError,
  queuedCountSpecs,
} from './funnel-diagnostics';

const NOW = new Date('2026-10-05T08:00:00Z');

describe('diagnosticsSpecs', () => {
  it('reads the last 30 days of S2 skips and good jobs, newest judged first', () => {
    const since = Timestamp.fromMillis(NOW.getTime() - 30 * 86_400_000);
    const specs = diagnosticsSpecs(NOW);
    expect(specs.s2Skips).toEqual({
      collection: 'jobs',
      filters: [
        { field: 'skip.stage', op: '==', value: 's2' },
        { field: 'judgedAt', op: '>=', value: since },
      ],
      orderBy: [{ field: 'judgedAt', direction: 'desc' }],
    });
    expect(specs.good.filters).toEqual([
      { field: 'verdict', op: 'in', value: ['apply', 'near_miss', 'wildcard'] },
      { field: 'judgedAt', op: '>=', value: since },
    ]);
  });

  it('reads the S3 queue newest first, and counts queued jobs with and without sortAt', () => {
    expect(diagnosticsSpecs(NOW).queuedS3).toMatchObject({
      filters: [{ field: 'next', op: '==', value: 's3' }],
      orderBy: [{ field: 'sortAt', direction: 'desc' }],
    });
    const counts = queuedCountSpecs('s2');
    expect(counts.all.orderBy).toEqual([]);
    expect(counts.withSortAt.orderBy).toEqual([{ field: 'sortAt', direction: 'desc' }]);
  });
});

describe('diagnosticsErrorMessage', () => {
  it('names a building index, and keeps other errors plain', () => {
    expect(diagnosticsErrorMessage(new IndexBuildingError('jobs'))).toMatch(/Index building/);
    expect(diagnosticsErrorMessage(new Error('x'))).toMatch(/Couldn't read/);
  });
});
