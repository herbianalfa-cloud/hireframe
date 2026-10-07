import { COLLECTIONS, type QuerySpec, type WaitState } from '@hireframe/shared';

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
