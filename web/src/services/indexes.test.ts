// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';

import {
  ADOPTED_S1_RULE_IDS,
  DIGEST_VERDICTS,
  digestJobsSpec,
  digestRunsSpec,
  digestSourcesSpec,
  digestWaitingSpec,
} from '@hireframe/shared';
import { dashboardQuerySpecs, lastRunSpec, summarySpecs } from './dashboard';
import { diagnosticsQuerySpecs } from './funnel-diagnostics';
import { addedByYouSpec, jobFilterSpec } from './jobs';
import { lookupKeysSpec, lookupUrlSpec, needsDescriptionSpec } from './lookup';
import { needsDescriptionCountSpec } from './system';
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

  it('serves the summary bar counts and the last run', () => {
    const specs = {
      ...Object.fromEntries(
        Object.entries(summarySpecs(NOW)).map(([key, spec]) => [`count:${key}`, spec]),
      ),
      'last-run': lastRunSpec,
    };
    expect(Object.keys(specs)).toHaveLength(5);
    for (const [name, spec] of Object.entries(specs)) {
      expect(indexServes(spec, indexes), name).toBe(true);
    }
    // The open counts are equality-only with no orderBy: served by merging the single-field
    // indexes on verdict and status, so they need no composite index.
    for (const key of ['apply', 'nearMiss', 'wildcard'] as const) {
      expect(summarySpecs(NOW)[key].orderBy, key).toEqual([]);
    }
    expect(Object.keys(dashboardQuerySpecs(NOW))).toContain('last-run');
  });

  it('serves every getDigest query', () => {
    const specs: Record<string, QuerySpec> = {
      'digest:runs': digestRunsSpec,
      'digest:waiting': digestWaitingSpec,
      'digest:sources': digestSourcesSpec,
      ...Object.fromEntries(
        DIGEST_VERDICTS.map((verdict) => [`digest:jobs:${verdict}`, digestJobsSpec(verdict, NOW)]),
      ),
    };
    expect(Object.keys(specs)).toHaveLength(6);
    for (const [name, spec] of Object.entries(specs)) {
      expect(indexServes(spec, indexes), name).toBe(true);
    }
    // The job lists use the existing (verdict, status, judgedAt desc) composite.
    expect(indexServes(digestJobsSpec('apply', NOW), [])).toBe(false);
    // The runs, waiting and sources reads need no composite index.
    for (const spec of [digestRunsSpec, digestWaitingSpec, digestSourcesSpec]) {
      expect(indexServes(spec, [])).toBe(true);
    }
  });

  it('serves every funnel diagnostics query', () => {
    const specs = diagnosticsQuerySpecs(NOW);
    expect(Object.keys(specs)).toHaveLength(7 + ADOPTED_S1_RULE_IDS.length);
    for (const [name, spec] of Object.entries(specs)) {
      expect(indexServes(spec, indexes), name).toBe(true);
    }
  });

  it('serves the System count of jobs waiting for a description without a new index', () => {
    expect(needsDescriptionCountSpec).toEqual({
      collection: 'jobs',
      filters: [{ field: 'next', op: '==', value: 'description' }],
      orderBy: [],
    });
    expect(indexServes(needsDescriptionCountSpec, indexes)).toBe(true);
    expect(indexServes(needsDescriptionCountSpec, [])).toBe(true);
  });

  it('serves every Lookup query', () => {
    const specs: Record<string, QuerySpec> = {
      'lookup:keys': lookupKeysSpec(['linkedin:4012345678', 'greenhouse:1']),
      'lookup:url': lookupUrlSpec('https://www.linkedin.com/jobs/view/4012345678'),
      'lookup:waiting': needsDescriptionSpec,
      'lookup:added-by-you': addedByYouSpec,
      'jobs:added-by-you': jobFilterSpec({ addedByYou: true }),
    };
    for (const [name, spec] of Object.entries(specs)) {
      expect(indexServes(spec, indexes), name).toBe(true);
    }
  });

  it('serves the Lookup key and URL matches and Added by you without a composite index', () => {
    expect(lookupKeysSpec(['a']).filters[0]?.op).toBe('array-contains-any');
    expect(indexServes(lookupKeysSpec(['a']), [])).toBe(true);
    expect(indexServes(lookupUrlSpec('https://example.test/'), [])).toBe(true);
    expect(indexServes(addedByYouSpec, [])).toBe(true);
    // The waiting list is ordered under an equality filter: it needs (next, sortAt desc).
    expect(indexServes(needsDescriptionSpec, [])).toBe(false);
    expect(
      indexes.some((index) => index.fields.map((f) => f.fieldPath).join() === 'next,sortAt'),
    ).toBe(true);
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
