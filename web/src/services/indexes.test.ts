// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';

import { dashboardQuerySpecs } from './dashboard';
import { jobFilterSpec } from './jobs';
import { indexServes, type CompositeIndex, type QuerySpec } from './query-spec';

const indexFile = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../firestore.indexes.json', import.meta.url)), 'utf8'),
) as { indexes: CompositeIndex[] };
const { indexes } = indexFile;

const NOW = new Date('2026-10-14T12:00:00Z');
const VERDICTS = [undefined, 'apply', 'near_miss', 'wildcard', 'skip'] as const;
const STATUSES = [undefined, 'new', 'saved', 'applied', 'skipped'] as const;

function jobsListSpecs(): Record<string, QuerySpec> {
  const specs: Record<string, QuerySpec> = {};
  for (const verdict of VERDICTS) {
    for (const status of STATUSES) {
      for (const needsReview of [false, true]) {
        const name = `jobs:${verdict ?? '*'}/${status ?? '*'}${needsReview ? '/needs-review' : ''}`;
        specs[name] = jobFilterSpec({
          ...(verdict ? { verdict } : {}),
          ...(status ? { status } : {}),
          needsReview,
        });
      }
    }
  }
  return specs;
}

describe('firestore.indexes.json', () => {
  it('serves every dashboard query', () => {
    for (const [name, spec] of Object.entries(dashboardQuerySpecs(NOW))) {
      expect(indexServes(spec, indexes), name).toBe(true);
    }
  });

  it('serves every Jobs filter combination', () => {
    for (const [name, spec] of Object.entries(jobsListSpecs())) {
      expect(indexServes(spec, indexes), name).toBe(true);
    }
  });
});

describe('indexServes', () => {
  const judgedToday = (direction: 'asc' | 'desc'): QuerySpec => ({
    collection: 'jobs',
    filters: [
      { field: 'verdict', op: 'in', value: ['apply'] },
      { field: 'judgedAt', op: '>=', value: Timestamp.fromDate(NOW) },
    ],
    orderBy: direction === 'desc' ? [{ field: 'judgedAt', direction }] : [],
  });

  it('rejects the v0.5.0 bug: an unordered range scans ascending against a descending index', () => {
    expect(indexServes(judgedToday('asc'), indexes)).toBe(false);
    expect(indexServes(judgedToday('desc'), indexes)).toBe(true);
  });

  it('rejects a sort direction, a field set or a collection no index has', () => {
    const base = jobFilterSpec({ verdict: 'apply' });
    expect(
      indexServes({ ...base, orderBy: [{ field: 'judgedAt', direction: 'asc' }] }, indexes),
    ).toBe(false);
    expect(
      indexServes({ ...base, orderBy: [{ field: 'firstSeenAt', direction: 'desc' }] }, indexes),
    ).toBe(false);
    expect(indexServes({ ...base, collection: 'other' }, indexes)).toBe(false);
  });
});
