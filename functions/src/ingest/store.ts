import {
  AlertMessageSchema,
  COLLECTIONS,
  PATHS,
  SourceHealthSchema,
  type SourceHealth,
} from '@hireframe/shared';
import type { Firestore } from 'firebase-admin/firestore';

import { log } from '../log.js';
import { firestoreScanStore } from '../scan/store.js';
import { timestampsToDates } from '../timestamps.js';
import type { AlertMessageRecord, IngestStore } from './run.js';

/**
 * Admin SDK reads and writes for email ingest (ADR-046, ADR-047). The lock, key lookup, job
 * writes and watchlist are the scan store's, so alert jobs are written exactly as a scan's are.
 * `alertMessages` and `nonces` are server-only: no client rule opens them.
 */

const EMAIL_SOURCE = 'email';

export function firestoreIngestStore(db: Firestore): IngestStore {
  const scan = firestoreScanStore(db);
  return {
    newRunId: scan.newRunId,
    acquireLock: scan.acquireLock,
    releaseLock: scan.releaseLock,
    findJobsByKeys: scan.findJobsByKeys,
    writePlan: scan.writePlan,
    watchedCompanies: scan.watchedCompanies,

    async seenMessages(hashes) {
      const seen = new Set<string>();
      if (hashes.length === 0) return seen;
      const snapshots = await db.getAll(
        ...hashes.map((hash) => db.collection(COLLECTIONS.alertMessages).doc(hash)),
      );
      for (const snapshot of snapshots) if (snapshot.exists) seen.add(snapshot.id);
      return seen;
    },

    async recordMessage(hash, record: AlertMessageRecord) {
      const valid = AlertMessageSchema.parse(record);
      await db.doc(PATHS.alertMessage(hash)).set(valid);
    },

    async readEmailHealth() {
      const snapshot = await db.doc(PATHS.source(EMAIL_SOURCE)).get();
      if (!snapshot.exists) return undefined;
      const parsed = SourceHealthSchema.safeParse(timestampsToDates(snapshot.data()));
      if (!parsed.success) {
        log.warn('store.invalid_doc', { collection: 'sources', count: 1 });
        return undefined;
      }
      return parsed.data;
    },

    async writeEmailHealth(health: SourceHealth) {
      await db.doc(PATHS.source(EMAIL_SOURCE)).set(health);
    },
  };
}
