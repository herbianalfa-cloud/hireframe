import { COLLECTIONS, type QuerySpec, type QueueStage } from '@hireframe/shared';

/**
 * Funnel queries described as data (ADR-040), so a test can check each against
 * `firestore.indexes.json`. Only the newer queries are built from specs; bringing the older
 * ones in is parked on the ROADMAP.
 */

/** Jobs waiting for `stage` whose `sortAt` is before `before`, newest first. */
export function staleQueuedSpec(stage: QueueStage, before: Date): QuerySpec {
  return {
    collection: COLLECTIONS.jobs,
    filters: [
      { field: 'next', op: '==', value: stage },
      { field: 'sortAt', op: '<', value: before },
    ],
    orderBy: [{ field: 'sortAt', direction: 'desc' }],
  };
}
