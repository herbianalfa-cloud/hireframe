import { PATHS, type LockHolder, type WipeStep } from '@hireframe/shared';
import type { Firestore } from 'firebase-admin/firestore';

import type { bucket as adminBucket } from '../admin.js';
import { WIPE } from '../config.js';
import { acquireOrRefreshWipe, firestoreScanStore, liveLockHolder } from '../scan/store.js';
import { WIPE_COLLECTIONS, WIPE_CV_FILES_PREFIX, planSourceDoc, type WipeDocStep } from './plan.js';
import type { WipeStore } from './run.js';

type Bucket = ReturnType<typeof adminBucket>;

/** Admin SDK side of Delete all my data (ADR-057). Nothing here stores progress. */
export function firestoreWipeStore(db: Firestore, bucket: Bucket): WipeStore {
  const scanStore = firestoreScanStore(db);

  async function deleteDocPage(step: WipeDocStep, limit: number) {
    const snapshot = await db.collection(WIPE_COLLECTIONS[step]).select().limit(limit).get();
    const batch = db.batch();
    let deleted = 0;
    for (const doc of snapshot.docs) {
      batch.delete(doc.ref);
      deleted += 1;
    }
    if (deleted > 0) await batch.commit();
    return { deleted, exhausted: snapshot.size < limit };
  }

  async function deleteJobsPage(limit: number) {
    // A job and its description go in one batch, so a failed batch leaves both or neither.
    const perPage = Math.max(1, Math.floor(limit / 2));
    const snapshot = await db.collection(WIPE_COLLECTIONS.jobs).select().limit(perPage).get();
    if (snapshot.empty) return { deleted: 0, exhausted: true };
    const batch = db.batch();
    for (const doc of snapshot.docs) {
      batch.delete(db.doc(PATHS.jobDescription(doc.id)));
      batch.delete(doc.ref);
    }
    await batch.commit();
    return { deleted: snapshot.size * 2, exhausted: snapshot.size < perPage };
  }

  async function wipeSources(limit: number) {
    const snapshot = await db.collection(WIPE_COLLECTIONS.sources).get();
    const batch = db.batch();
    let changed = 0;
    for (const doc of snapshot.docs) {
      if (changed >= Math.min(limit, WIPE.batchOps)) break;
      const plan = planSourceDoc(doc.data());
      if (plan.action === 'keep') continue;
      if (plan.action === 'delete') batch.delete(doc.ref);
      else {
        batch.set(doc.ref, { ...plan.kept, updatedAt: new Date(), schemaVersion: 1 });
      }
      changed += 1;
    }
    if (changed > 0) await batch.commit();
    return { deleted: changed, exhausted: true };
  }

  return {
    liveLockHolder: (now): Promise<LockHolder | null> => liveLockHolder(db, now),

    async hasGenerating() {
      const snapshot = await db
        .collection(WIPE_COLLECTIONS.applications)
        .where('stage', '==', 'generating')
        .limit(1)
        .get();
      return !snapshot.empty;
    },

    acquire: (now) => acquireOrRefreshWipe(db, now),

    // A short holder: `lastFinishedAt` is kept, so no manual-scan cooldown starts.
    release: (now) => scanStore.releaseLock('wipe', now),

    deletePage(step, limit) {
      if (step === 'jobs') return deleteJobsPage(limit);
      if (step === 'sources') return wipeSources(limit);
      return deleteDocPage(step, limit);
    },

    async deleteFilesPage(pageSize) {
      const [found, next] = await bucket.getFiles({
        prefix: WIPE_CV_FILES_PREFIX,
        maxResults: pageSize,
        autoPaginate: false,
      });
      let index = 0;
      const workers = Array.from(
        { length: Math.min(WIPE.fileDeleteConcurrency, found.length) },
        async () => {
          while (index < found.length) {
            const file = found[index];
            index += 1;
            if (file) await file.delete({ ignoreNotFound: true });
          }
        },
      );
      await Promise.all(workers);
      return { deleted: found.length, exhausted: !next };
    },

    async hasAny(step: WipeStep) {
      if (step === 'cvFiles') {
        const [found] = await bucket.getFiles({
          prefix: WIPE_CV_FILES_PREFIX,
          maxResults: 1,
          autoPaginate: false,
        });
        return found.length > 0;
      }
      if (step === 'sources') {
        const snapshot = await db.collection(WIPE_COLLECTIONS.sources).get();
        return snapshot.docs.some((doc) => planSourceDoc(doc.data()).action !== 'keep');
      }
      const snapshot = await db.collection(WIPE_COLLECTIONS[step]).select().limit(1).get();
      return !snapshot.empty;
    },
  };
}
