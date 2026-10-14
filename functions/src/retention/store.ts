import { DOCS, PATHS } from '@hireframe/shared';
import { FieldPath, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

import { log } from '../log.js';
import { timestampsToDates } from '../timestamps.js';
import { oldSkipsSpec } from './queries.js';
import { decidePurge, type PurgeCandidate, type RetentionStore } from './run.js';

/** The cursor document as stored; anything else counts as no cursor (a fresh start). */
const CursorSchema = z.object({
  purgedThrough: z.instanceof(Timestamp),
  lastId: z.string().min(1),
});

/** One page row: only the field the cursor needs. */
const PageRowSchema = z.object({ judgedAt: z.instanceof(Timestamp) });

/**
 * The job fields the purge decision reads (a fresh read inside the transaction). A malformed
 * document fails the parse and counts as kept, so one bad job can't fail the chunk and pin the
 * cursor behind it every night.
 */
const PurgeCandidateSchema = z.object({
  verdict: z.string().exactOptional(),
  judgedAt: z.date().exactOptional(),
  status: z.string().exactOptional(),
  descriptionKind: z.string().exactOptional(),
  descriptionPurgedAt: z.date().exactOptional(),
});

/** Admin SDK side of the retention job (ADR-057). Nothing here is read by the client. */
export function firestoreRetentionStore(db: Firestore): RetentionStore {
  return {
    async readCursor() {
      const data = (await db.doc(DOCS.retentionCursor).get()).data();
      if (data === undefined) return null;
      const parsed = CursorSchema.safeParse(data);
      if (!parsed.success) {
        log.warn('retention.invalid_cursor', {});
        return null;
      }
      return { purgedThrough: parsed.data.purgedThrough.toDate(), lastId: parsed.data.lastId };
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
        const row = PageRowSchema.safeParse(doc.data());
        return row.success ? [{ id: doc.id, judgedAt: row.data.judgedAt.toDate() }] : [];
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
          let data: PurgeCandidate | null = null;
          if (job?.exists) {
            const parsed = PurgeCandidateSchema.safeParse(timestampsToDates(job.data()));
            if (parsed.success) data = parsed.data;
            else log.warn('retention.invalid_doc', { jobId: id });
          }
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
