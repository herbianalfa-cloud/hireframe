import { DOCS, PATHS } from '@hireframe/shared';
import { FieldPath, Timestamp, type Firestore } from 'firebase-admin/firestore';

import { timestampsToDates } from '../timestamps.js';
import { oldSkipsSpec } from './queries.js';
import { decidePurge, type PurgeCandidate, type RetentionStore } from './run.js';

/** Admin SDK side of the retention job (ADR-057). Nothing here is read by the client. */
export function firestoreRetentionStore(db: Firestore): RetentionStore {
  return {
    async readCursor() {
      const data = (await db.doc(DOCS.retentionCursor).get()).data();
      const purgedThrough: unknown = data?.purgedThrough;
      const lastId: unknown = data?.lastId;
      if (!(purgedThrough instanceof Timestamp) || typeof lastId !== 'string') return null;
      return { purgedThrough: purgedThrough.toDate(), lastId };
    },

    async readPage(cutoff, after, limit) {
      const spec = oldSkipsSpec(cutoff);
      let query = db
        .collection(spec.collection)
        .where('verdict', '==', 'skip')
        .where('judgedAt', '<', cutoff)
        .orderBy('judgedAt', 'asc')
        .orderBy(FieldPath.documentId(), 'asc')
        .select('judgedAt');
      if (after) query = query.startAfter(Timestamp.fromDate(after.purgedThrough), after.lastId);
      const snapshot = await query.limit(limit).get();
      return snapshot.docs.flatMap((doc) => {
        const judgedAt: unknown = doc.get('judgedAt');
        return judgedAt instanceof Timestamp ? [{ id: doc.id, judgedAt: judgedAt.toDate() }] : [];
      });
    },

    // A transaction, not a batch with a precondition, so the application check can't race a Start.
    // At most 100 jobs: 200 writes, inside the 400-op limit.
    purgeChunk(ids, cutoff, now) {
      return db.runTransaction(async (tx) => {
        const jobRefs = ids.map((id) => db.doc(PATHS.job(id)));
        const appRefs = ids.map((id) => db.doc(PATHS.application(id)));
        const snapshots = await tx.getAll(...jobRefs, ...appRefs);
        const outcome = { purged: 0, skippedKept: 0, skippedApplication: 0 };
        ids.forEach((id, index) => {
          const job = snapshots[index];
          const application = snapshots[ids.length + index];
          const data = job?.exists ? (timestampsToDates(job.data()) as PurgeCandidate) : null;
          const decision = decidePurge(data, application?.exists ?? false, cutoff);
          if (decision === 'application') outcome.skippedApplication += 1;
          else if (decision === 'kept') outcome.skippedKept += 1;
          else {
            tx.delete(db.doc(PATHS.jobDescription(id)));
            tx.update(db.doc(PATHS.job(id)), { descriptionPurgedAt: now, updatedAt: now });
            outcome.purged += 1;
          }
        });
        return outcome;
      });
    },

    async saveCursor(cursor, now) {
      await db.doc(DOCS.retentionCursor).set({
        purgedThrough: cursor.purgedThrough,
        lastId: cursor.lastId,
        lastRunAt: now,
        schemaVersion: 1,
      });
    },
  };
}
