import { COLLECTIONS, type QuerySpec, type QueueStage, type WaitState } from '@hireframe/shared';

/**
 * Funnel queries described as data (ADR-040), so a test can check each against
 * `firestore.indexes.json`. Only the newer queries are built from specs; bringing the older
 * ones in is parked on the ROADMAP.
 */

/**
 * Jobs waiting for `state` (a model stage, or `description`, ADR-048) whose `sortAt` is before
 * `before`, newest first. The `(next, sortAt desc)` index serves all three.
 */
export function staleQueuedSpec(state: WaitState, before: Date): QuerySpec {
  return {
    collection: COLLECTIONS.jobs,
    filters: [
      { field: 'next', op: '==', value: state },
      { field: 'sortAt', op: '<', value: before },
    ],
    orderBy: [{ field: 'sortAt', direction: 'desc' }],
  };
}

/**
 * Jobs with a description claim older than `before` (ADR-049): a `describe` that died after
 * claiming the job. Ordered by the one field it filters, so the automatic index serves it; jobs
 * without `describingAt` are left out by Firestore, which is exactly the filter.
 */
export function staleDescribingSpec(before: Date): QuerySpec {
  return {
    collection: COLLECTIONS.jobs,
    filters: [{ field: 'describingAt', op: '<', value: before }],
    orderBy: [{ field: 'describingAt', direction: 'asc' }],
  };
}

/** The fields a key lookup reads from stored jobs (a `select` projection). */
export const JOBS_BY_KEYS_SELECT = [
  'keys',
  'firstSeenAt',
  'sources',
  'descriptionKind',
  'next',
  'postedAt',
] as const;

/**
 * Stored jobs carrying any of `keys` (at most 30: `array-contains-any`'s limit), read to dedupe
 * an ingest against them. An equality-style filter, served by the automatic single-field index.
 */
export function jobsByKeysSpec(keys: readonly string[]): QuerySpec {
  return {
    collection: COLLECTIONS.jobs,
    filters: [{ field: 'keys', op: 'array-contains-any', value: keys }],
    orderBy: [],
  };
}

/**
 * Jobs the owner added from Lookup that wait for `stage`, newest first (ADR-049): read before the
 * usual queue order so they are judged first. Needs the `(next, addedAt desc)` composite; jobs
 * without `addedAt` are left out by Firestore, which is exactly the filter.
 */
export function addedQueuedSpec(stage: QueueStage): QuerySpec {
  return {
    collection: COLLECTIONS.jobs,
    filters: [{ field: 'next', op: '==', value: stage }],
    orderBy: [{ field: 'addedAt', direction: 'desc' }],
  };
}

/** Watched companies, whose boards the ATS search looks a posting up in (ADR-049). */
export function watchedCompaniesSpec(): QuerySpec {
  return {
    collection: COLLECTIONS.companies,
    filters: [{ field: 'watch', op: '==', value: true }],
    orderBy: [],
  };
}
