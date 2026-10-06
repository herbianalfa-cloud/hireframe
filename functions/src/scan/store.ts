import {
  buildNewJob,
  CompanySchema,
  COLLECTIONS,
  DOCS,
  JobKeysProjectionSchema,
  PATHS,
  QuotaSchema,
  ScanLockSchema,
  SCAN_SOURCE_IDS,
  SourceHealthSchema,
  sourceRef,
  type Company,
  type CompanySeed,
  type ExistingJobKeys,
  type LockHolder,
  type Quota,
  type ScanSourceId,
  type SourceHealth,
} from '@hireframe/shared';
import {
  FieldValue,
  type DocumentReference,
  type Firestore,
  type Query,
  type WriteBatch,
} from 'firebase-admin/firestore';

import { SCAN, SHORT_LOCK } from '../config.js';
import { JOBS_BY_KEYS_SELECT, jobsByKeysSpec } from '../funnel/queries.js';
import { errorFields, log } from '../log.js';
import { timestampsToDates } from '../timestamps.js';
import { eachLimited } from '../sources/types.js';
import type { LockResult, ScanStore, StoredCompany } from './run.js';

/**
 * Admin SDK reads and writes for a scan (ADR-029). Clients can read `jobs`, `runs`,
 * `companies`, `sources` and `locks` but never write them (firestore.rules).
 */

function isShortHolder(holder: LockHolder | undefined): boolean {
  return holder === 'email' || holder === 'lookup';
}

/** How long a lock may stay held before it counts as dead (ADR-048). */
export function lockStaleMs(holder: LockHolder): number {
  return holder === 'email' ? SHORT_LOCK.emailStaleMs : SCAN.lockStaleMs;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function firestoreScanStore(db: Firestore): ScanStore {
  const lockRef = db.doc(DOCS.scanLock);

  return {
    newRunId: () => db.collection(COLLECTIONS.runs).doc().id,

    acquireLock(runId, now, cooldownMs, holder = 'scan') {
      return db.runTransaction(async (tx): Promise<LockResult> => {
        const snapshot = await tx.get(lockRef);
        // An unreadable lock is treated as free: blocking every scan forever would be worse.
        const parsed = ScanLockSchema.safeParse(timestampsToDates(snapshot.data()));
        const lock = parsed.success ? parsed.data : undefined;
        // `staleAt` is optional (locks written before M6 have none): fall back to the scan's.
        const staleAt = lock?.startedAt
          ? (lock.staleAt ?? new Date(lock.startedAt.getTime() + SCAN.lockStaleMs))
          : undefined;
        if (lock?.runId && staleAt && now.getTime() < staleAt.getTime()) {
          return { ok: false, reason: 'running', holder: lock.holder ?? 'scan' };
        }
        if (lock?.lastFinishedAt && now.getTime() - lock.lastFinishedAt.getTime() < cooldownMs) {
          return { ok: false, reason: 'recent', lastFinishedAt: lock.lastFinishedAt };
        }
        // A stale lock belongs to a scan that was killed before its `finally` ran (callable
        // timeout or memory), so its run is still `running`: mark it failed while taking over.
        // Short holders have no run record.
        const deadScan = lock?.runId && !isShortHolder(lock.holder);
        const deadRunRef = deadScan && lock.runId ? db.doc(PATHS.run(lock.runId)) : null;
        const deadRun = deadRunRef ? await tx.get(deadRunRef) : null;
        const recovered =
          deadRunRef && deadRun?.exists && deadRun.get('status') === 'running' ? deadRunRef : null;
        tx.set(lockRef, {
          runId,
          startedAt: now,
          holder,
          staleAt: new Date(now.getTime() + lockStaleMs(holder)),
          ...(lock?.lastFinishedAt ? { lastFinishedAt: lock.lastFinishedAt } : {}),
          schemaVersion: 1,
        });
        if (recovered) {
          tx.update(recovered, {
            status: 'failed',
            finishedAt: now,
            errors: FieldValue.arrayUnion({ code: 'timeout' }),
          });
          return { ok: true, recovered: recovered.id };
        }
        return { ok: true };
      });
    },

    async releaseLock(runId, now) {
      await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(lockRef);
        const lock = ScanLockSchema.safeParse(timestampsToDates(snapshot.data()));
        // Only the run holding the lock releases it (a stale one may have been taken over).
        if (!lock.success || lock.data.runId !== runId) return;
        // A short holder never counts as a finished scan: it must not start the manual-scan
        // cooldown, so the previous scan's finish time stays.
        const finishedAt = isShortHolder(lock.data.holder) ? lock.data.lastFinishedAt : now;
        tx.set(lockRef, {
          ...(finishedAt ? { lastFinishedAt: finishedAt } : {}),
          schemaVersion: 1,
        });
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
      for (const part of chunks(seed, SCAN.seedReadChunk)) {
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
      const invalid = new Set<string>();
      const lookups = chunks(keys, SCAN.keyLookupChunk);
      await eachLimited(lookups, SCAN.keyLookupConcurrency, async (chunk) => {
        const spec = jobsByKeysSpec(chunk);
        const query = spec.filters.reduce<Query>(
          (found, filter) => found.where(filter.field, filter.op, filter.value),
          db.collection(spec.collection),
        );
        const snapshot = await query.select(...JOBS_BY_KEYS_SELECT).get();
        for (const doc of snapshot.docs) {
          const parsed = JobKeysProjectionSchema.safeParse(timestampsToDates(doc.data()));
          if (!parsed.success) {
            invalid.add(doc.id);
            continue;
          }
          const {
            keys: jobKeys,
            firstSeenAt,
            sources,
            descriptionKind,
            next,
            postedAt,
          } = parsed.data;
          found.set(doc.id, {
            id: doc.id,
            keys: jobKeys,
            firstSeenAt,
            sourceCount: sources.length,
            ...(descriptionKind ? { descriptionKind } : {}),
            ...(next === undefined ? {} : { next }),
            ...(postedAt ? { postedAt } : {}),
          });
        }
      });
      // A snippet-only job's stored text length, so an upgrade only replaces a shorter text.
      const snippetIds = [...found.values()]
        .filter((job) => job.descriptionKind === 'snippet')
        .map((job) => job.id);
      for (const part of chunks(snippetIds, SCAN.keyLookupChunk)) {
        const snapshots = await db.getAll(...part.map((id) => db.doc(PATHS.jobDescription(id))));
        snapshots.forEach((snapshot, index) => {
          const id = part[index];
          const job = id === undefined ? undefined : found.get(id);
          const text: unknown = snapshot.exists ? snapshot.get('text') : undefined;
          if (job && typeof text === 'string') job.descriptionChars = text.length;
        });
      }
      // An unreadable job can't be matched; skipping it may add a duplicate, never lose a job.
      if (invalid.size > 0)
        log.warn('store.invalid_doc', { collection: 'jobs', count: invalid.size });
      return [...found.values()];
    },

    async writePlan(plan, now) {
      type Write = (batch: WriteBatch) => void;
      const writes: { ops: number; apply: Write }[] = [];
      for (const group of plan.creates) {
        const jobRef = db.collection(COLLECTIONS.jobs).doc();
        const { job, description, droppedKeys } = buildNewJob(
          group,
          PATHS.jobDescription(jobRef.id),
          now,
        );
        if (droppedKeys > 0) log.warn('ingest.keys_truncated', { dropped: droppedKeys });
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
        const { upgrade } = update;
        writes.push({
          ops: upgrade ? 2 : 1,
          apply: (batch) => {
            batch.update(ref, {
              sources: FieldValue.arrayUnion(
                ...update.addSources.map((job) => sourceRef(job, now)),
              ),
              ...(update.addKeys.length ? { keys: FieldValue.arrayUnion(...update.addKeys) } : {}),
              // A merge that brings full text to a job without it replaces the description, fills
              // a missing posting date and releases a job waiting for one (ADR-048).
              ...(upgrade
                ? {
                    descriptionKind: 'full',
                    ...(upgrade.postedAt ? { postedAt: upgrade.postedAt } : {}),
                    ...(upgrade.release
                      ? { next: 's3', flags: FieldValue.arrayRemove('needs_description') }
                      : {}),
                  }
                : {}),
              updatedAt: now,
            });
            if (upgrade) {
              batch.set(db.doc(PATHS.jobDescription(update.jobId)), {
                text: upgrade.text,
                kind: 'full',
                sourceId: upgrade.sourceId,
                fetchedAt: now,
                schemaVersion: 1,
              });
            }
          },
        });
      }

      let failedWrites = 0;
      let pending: typeof writes = [];
      let ops = 0;
      // A failed batch is retried one write at a time, so one bad write (e.g. an update to a job
      // deleted since the lookup) never takes the good ones down with it. A create's job and
      // description stay in one batch either way.
      const commit = async () => {
        if (pending.length === 0) return;
        const batch = db.batch();
        for (const write of pending) write.apply(batch);
        try {
          await batch.commit();
        } catch {
          for (const write of pending) {
            const single = db.batch();
            write.apply(single);
            try {
              await single.commit();
            } catch (error) {
              failedWrites += 1;
              log.error('ingest.write_failed', {
                collection: 'jobs',
                writes: 1,
                ...errorFields(error),
              });
            }
          }
        }
        pending = [];
        ops = 0;
      };
      for (const write of writes) {
        if (ops + write.ops > SCAN.writeBatchOps) await commit();
        pending.push(write);
        ops += write.ops;
      }
      await commit();
      return { failedWrites };
    },

    async updateCompanies(updates, now) {
      let failedWrites = 0;
      for (const part of chunks(updates, SCAN.writeBatchOps)) {
        const batch = db.batch();
        // `update`, not `set`: a company deleted mid-run must not come back as a partial doc.
        for (const { companyId, lastScan } of part) {
          batch.update(db.doc(PATHS.company(companyId)), {
            lastScan: withDates(lastScan),
            lastScannedAt: now,
            updatedAt: now,
          });
        }
        try {
          await batch.commit();
        } catch (error) {
          failedWrites += part.length;
          log.error('ingest.write_failed', {
            collection: 'companies',
            writes: part.length,
            ...errorFields(error),
          });
        }
      }
      return { failedWrites };
    },

    async quotas() {
      const snapshots = await db.getAll(...SCAN_SOURCE_IDS.map((id) => db.doc(PATHS.source(id))));
      const quotas: Partial<Record<ScanSourceId, Quota>> = {};
      snapshots.forEach((snapshot, index) => {
        const id = SCAN_SOURCE_IDS[index];
        if (!id || !snapshot.exists) return;
        const parsed = QuotaSchema.safeParse(timestampsToDates(snapshot.get('quota')));
        if (parsed.success) quotas[id] = parsed.data;
      });
      return quotas;
    },

    async saveQuota(sourceId, quota) {
      await db.doc(PATHS.source(sourceId)).set({ quota: withDates(quota) }, { merge: true });
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
