import {
  buildNewJob,
  CompanySchema,
  COLLECTIONS,
  DOCS,
  PATHS,
  ScanLockSchema,
  SCAN_SOURCE_IDS,
  SourceHealthSchema,
  sourceRef,
  type Company,
  type CompanySeed,
  type ExistingJobKeys,
  type ScanSourceId,
  type SourceHealth,
} from '@hireframe/shared';
import {
  FieldValue,
  type DocumentReference,
  type Firestore,
  type WriteBatch,
} from 'firebase-admin/firestore';

import { SCAN } from '../config.js';
import { errorFields, log } from '../log.js';
import { timestampsToDates } from '../timestamps.js';
import { eachLimited } from '../sources/types.js';
import type { LockResult, ScanStore, StoredCompany } from './run.js';

/**
 * Admin SDK reads and writes for a scan (ADR-029). Clients can read `jobs`, `runs`,
 * `companies`, `sources` and `locks` but never write them (firestore.rules).
 */

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function firestoreScanStore(db: Firestore): ScanStore {
  const lockRef = db.doc(DOCS.scanLock);

  return {
    newRunId: () => db.collection(COLLECTIONS.runs).doc().id,

    acquireLock(runId, now, cooldownMs) {
      return db.runTransaction(async (tx): Promise<LockResult> => {
        const snapshot = await tx.get(lockRef);
        // An unreadable lock is treated as free: blocking every scan forever would be worse.
        const parsed = ScanLockSchema.safeParse(timestampsToDates(snapshot.data()));
        const lock = parsed.success ? parsed.data : undefined;
        if (
          lock?.runId &&
          lock.startedAt &&
          now.getTime() - lock.startedAt.getTime() < SCAN.lockStaleMs
        ) {
          return { ok: false, reason: 'running' };
        }
        if (lock?.lastFinishedAt && now.getTime() - lock.lastFinishedAt.getTime() < cooldownMs) {
          return { ok: false, reason: 'recent', lastFinishedAt: lock.lastFinishedAt };
        }
        tx.set(lockRef, {
          runId,
          startedAt: now,
          ...(lock?.lastFinishedAt ? { lastFinishedAt: lock.lastFinishedAt } : {}),
          schemaVersion: 1,
        });
        return { ok: true };
      });
    },

    async releaseLock(runId, now) {
      await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(lockRef);
        // Only the run holding the lock releases it (a stale one may have been taken over).
        if (snapshot.get('runId') !== runId) return;
        tx.set(lockRef, { lastFinishedAt: now, schemaVersion: 1 });
      });
    },

    async createRun(runId, run) {
      await db.doc(PATHS.run(runId)).create(withDates(run));
    },

    async finishRun(runId, run) {
      await db.doc(PATHS.run(runId)).set(withDates(run));
    },

    async ensureSeedCompanies(seed, now) {
      let created = 0;
      for (const part of chunks(seed, 200)) {
        const refs = part.map((company) => db.doc(PATHS.company(company.id)));
        const snapshots = refs.length ? await db.getAll(...refs) : [];
        const missing = part.filter((_, index) => !snapshots[index]?.exists);
        if (missing.length === 0) continue;
        const batch = db.batch();
        for (const company of missing) {
          batch.create(db.doc(PATHS.company(company.id)), seedCompanyDocument(company, now));
        }
        await batch.commit();
        created += missing.length;
      }
      return created;
    },

    async watchedCompanies() {
      const snapshot = await db.collection(COLLECTIONS.companies).where('watch', '==', true).get();
      const companies: StoredCompany[] = [];
      let invalid = 0;
      for (const doc of snapshot.docs) {
        const parsed = CompanySchema.safeParse(timestampsToDates(doc.data()));
        if (!parsed.success) {
          invalid += 1;
          continue;
        }
        companies.push({
          company: {
            id: doc.id,
            name: parsed.data.name,
            ats: parsed.data.ats,
            ...(parsed.data.lastScannedAt ? { lastScannedAt: parsed.data.lastScannedAt } : {}),
          },
          ...(parsed.data.lastScan ? { lastScan: parsed.data.lastScan } : {}),
        });
      }
      if (invalid > 0) log.warn('store.invalid_doc', { collection: 'companies', count: invalid });
      return companies;
    },

    async sourceStates() {
      const refs = SCAN_SOURCE_IDS.map((id) => db.doc(PATHS.source(id)));
      const snapshots = await db.getAll(...refs);
      const states: Partial<Record<ScanSourceId, SourceHealth>> = {};
      snapshots.forEach((snapshot, index) => {
        const id = SCAN_SOURCE_IDS[index];
        if (!id || !snapshot.exists) return;
        const parsed = SourceHealthSchema.safeParse(timestampsToDates(snapshot.data()));
        if (parsed.success) states[id] = parsed.data;
        else log.warn('store.invalid_doc', { collection: 'sources', count: 1 });
      });
      return states;
    },

    async findJobsByKeys(keys) {
      const found = new Map<string, ExistingJobKeys>();
      await eachLimited(chunks(keys, SCAN.keyLookupChunk), 8, async (chunk) => {
        const snapshot = await db
          .collection(COLLECTIONS.jobs)
          .where('keys', 'array-contains-any', chunk)
          .select('keys', 'firstSeenAt', 'sources')
          .get();
        for (const doc of snapshot.docs) {
          const data = timestampsToDates(doc.data()) as Record<string, unknown>;
          const jobKeys = Array.isArray(data.keys)
            ? data.keys.filter((k): k is string => typeof k === 'string')
            : [];
          const firstSeenAt = data.firstSeenAt instanceof Date ? data.firstSeenAt : new Date(0);
          const sourceCount = Array.isArray(data.sources) ? data.sources.length : 0;
          found.set(doc.id, { id: doc.id, keys: jobKeys, firstSeenAt, sourceCount });
        }
      });
      return [...found.values()];
    },

    async writePlan(plan, now) {
      type Write = (batch: WriteBatch) => void;
      const writes: { ops: number; apply: Write }[] = [];
      for (const group of plan.creates) {
        const jobRef = db.collection(COLLECTIONS.jobs).doc();
        const { job, description } = buildNewJob(group, PATHS.jobDescription(jobRef.id), now);
        writes.push({
          ops: 2,
          apply: (batch) => {
            batch.create(jobRef, job);
            batch.create(db.doc(PATHS.jobDescription(jobRef.id)), description);
          },
        });
      }
      for (const update of plan.updates) {
        const ref: DocumentReference = db.doc(PATHS.job(update.jobId));
        writes.push({
          ops: 1,
          apply: (batch) => {
            batch.update(ref, {
              sources: FieldValue.arrayUnion(
                ...update.addSources.map((job) => sourceRef(job, now)),
              ),
              ...(update.addKeys.length ? { keys: FieldValue.arrayUnion(...update.addKeys) } : {}),
              updatedAt: now,
            });
          },
        });
      }

      let failedWrites = 0;
      let batch = db.batch();
      let ops = 0;
      let pending = 0;
      const commit = async () => {
        if (ops === 0) return;
        const size = pending;
        try {
          await batch.commit();
        } catch (error) {
          failedWrites += size;
          log.error('ingest.write_failed', { writes: size, ...errorFields(error) });
        }
        batch = db.batch();
        ops = 0;
        pending = 0;
      };
      for (const write of writes) {
        if (ops + write.ops > SCAN.writeBatchOps) await commit();
        write.apply(batch);
        ops += write.ops;
        pending += 1;
      }
      await commit();
      return { failedWrites };
    },

    async updateCompanies(updates, now) {
      for (const part of chunks(updates, SCAN.writeBatchOps)) {
        const batch = db.batch();
        for (const { companyId, lastScan } of part) {
          batch.update(db.doc(PATHS.company(companyId)), {
            lastScan: withDates(lastScan),
            lastScannedAt: now,
            updatedAt: now,
          });
        }
        await batch.commit();
      }
    },

    async writeSourceHealth(states) {
      const batch = db.batch();
      for (const [id, health] of Object.entries(states)) {
        batch.set(db.doc(PATHS.source(id)), withDates(health));
      }
      await batch.commit();
    },
  };
}

function seedCompanyDocument(seed: CompanySeed, now: Date): Company {
  return {
    name: seed.name,
    domain: seed.domain,
    ats: seed.ats,
    hq: seed.hq,
    ...(seed.size ? { size: seed.size } : {}),
    ...(seed.stage ? { stage: seed.stage } : {}),
    watch: true,
    origin: 'seed',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
}

/** Objects with `Date`s and optional fields, without any `undefined` (Firestore rejects it). */
function withDates<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .map(([key, inner]: [string, unknown]) => [
        key,
        inner !== null &&
        typeof inner === 'object' &&
        !(inner instanceof Date) &&
        !Array.isArray(inner)
          ? withDates(inner)
          : inner,
      ]),
  ) as T;
}
