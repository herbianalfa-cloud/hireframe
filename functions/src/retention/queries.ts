import { COLLECTIONS, type QuerySpec } from '@hireframe/shared';

/**
 * The retention job's page query as data (ADR-040), so a test can check it against
 * `firestore.indexes.json`. Ordered by `judgedAt` ascending, then by document ID (the cursor is
 * `(judgedAt, id)`, because one run stamps one `judgedAt` on hundreds of skips). The existing
 * `(verdict, judgedAt desc)` index can't serve an ascending order, so this one is its own index.
 */
export function oldSkipsSpec(cutoff: Date): QuerySpec {
  return {
    collection: COLLECTIONS.jobs,
    filters: [
      { field: 'verdict', op: '==', value: 'skip' },
      { field: 'judgedAt', op: '<', value: cutoff },
    ],
    orderBy: [{ field: 'judgedAt', direction: 'asc' }],
  };
}
