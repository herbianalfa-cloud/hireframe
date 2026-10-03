import {
  COLLECTIONS,
  DOCS,
  FactSchema,
  FUNNEL_JOB_FIELDS,
  JobDescriptionSchema,
  JobFunnelFieldsSchema,
  JobSchema,
  JOB_STAGES,
  PATHS,
  ProfileSettingsSchema,
  QuotaSchema,
  SourceHealthSchema,
  type FunnelFact,
  type Quota,
  type QueueStage,
} from '@hireframe/shared';
import { FieldValue, type Firestore, type Query } from 'firebase-admin/firestore';

import { SCAN } from '../config.js';
import type { HostPause } from '../http/client.js';
import { errorFields, log } from '../log.js';
import { timestampsToDates } from '../timestamps.js';
import type { JobPatch } from './judgement.js';
import type { CompanyInfo, FunnelStore, StoredJob } from './run.js';

/**
 * Admin SDK reads and writes for the funnel. Writes touch only funnel fields on existing jobs
 * (`FUNNEL_JOB_FIELDS` plus `stage`), validated before they're sent, and a job's description
 * when Reed full text replaces a snippet. Nothing here can write criteria, the profile or config.
 */

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const ALLOWED = new Set<string>([...FUNNEL_JOB_FIELDS, 'stage']);
const PatchSetSchema = JobFunnelFieldsSchema.partial();

/** The Firestore update for a patch, or null if it names a field the funnel may not write. */
export function patchUpdate(patch: JobPatch, now: Date): Record<string, unknown> | null {
  const { stage, ...fields } = patch.set;
  const names = [...Object.keys(patch.set), ...patch.clear];
  if (names.some((name) => !ALLOWED.has(name))) return null;
  if (stage !== undefined && !(JOB_STAGES as readonly string[]).includes(stage)) return null;
  if (!PatchSetSchema.safeParse(fields).success) return null;
  return {
    ...patch.set,
    ...Object.fromEntries(patch.clear.map((name) => [name, FieldValue.delete()])),
    ...(patch.addCostPence ? { costPence: FieldValue.increment(patch.addCostPence) } : {}),
    updatedAt: now,
  };
}

export interface FirestoreFunnelStore extends FunnelStore {
  saveFullText(jobId: string, text: string, now: Date): Promise<void>;
  reedQuota(): Promise<Quota | undefined>;
  /** Hosts Reed's last scan was told to stay away from (a long Retry-After). */
  reedPauses(): Promise<HostPause[]>;
  saveReedQuota(quota: Quota): Promise<void>;
}

export function firestoreFunnelStore(db: Firestore): FirestoreFunnelStore {
  const jobs = db.collection(COLLECTIONS.jobs);

  async function read(query: Query): Promise<StoredJob[]> {
    const snapshot = await query.get();
    const found: StoredJob[] = [];
    let invalid = 0;
    for (const doc of snapshot.docs) {
      const parsed = JobSchema.safeParse(timestampsToDates(doc.data()));
      if (parsed.success) found.push({ id: doc.id, job: parsed.data });
      else invalid += 1;
    }
    if (invalid > 0) log.warn('store.invalid_doc', { collection: 'jobs', count: invalid });
    return found;
  }

  return {
    async loadProfile() {
      const [factsSnapshot, settingsSnapshot] = await Promise.all([
        db.collection(PATHS.facts).where('status', '==', 'active').get(),
        db.doc(DOCS.profileMain).get(),
      ]);
      const facts: FunnelFact[] = [];
      let invalid = 0;
      for (const doc of factsSnapshot.docs) {
        const parsed = FactSchema.safeParse(timestampsToDates(doc.data()));
        if (!parsed.success) {
          invalid += 1;
          continue;
        }
        const { type, text, dates, lanes } = parsed.data;
        facts.push({ id: doc.id, type, text, dates, lanes });
      }
      if (invalid > 0) log.warn('store.invalid_doc', { collection: 'facts', count: invalid });
      const settings = settingsSnapshot.exists
        ? ProfileSettingsSchema.safeParse(timestampsToDates(settingsSnapshot.data()))
        : null;
      if (settings && !settings.success) {
        log.warn('store.invalid_doc', { collection: 'profile', count: 1 });
      }
      return {
        facts,
        workRights: settings?.success
          ? {
              workRights: settings.data.workRights,
              ...(settings.data.validUntil ? { validUntil: settings.data.validUntil } : {}),
            }
          : null,
      };
    },

    s0Jobs: (limit) =>
      limit > 0
        ? read(jobs.where('stage', '==', 's0').orderBy('firstSeenAt', 'desc').limit(limit))
        : Promise.resolve([]),

    queued(stage: QueueStage, limit) {
      if (limit <= 0) return Promise.resolve([]);
      const base = jobs.where('next', '==', stage);
      return read(
        stage === 's2'
          ? base.orderBy('sortAt', 'desc').limit(limit)
          : base.orderBy('triage.triageScore', 'desc').orderBy('sortAt', 'desc').limit(limit),
      );
    },

    recentJobs: (since, limit) =>
      read(jobs.where('firstSeenAt', '>=', since).orderBy('firstSeenAt', 'desc').limit(limit)),

    async descriptions(jobIds) {
      const texts = new Map<string, string>();
      for (const part of chunks(jobIds, 100)) {
        if (part.length === 0) continue;
        const snapshots = await db.getAll(...part.map((id) => db.doc(PATHS.jobDescription(id))));
        snapshots.forEach((snapshot, index) => {
          const id = part[index];
          if (!id || !snapshot.exists) return;
          const parsed = JobDescriptionSchema.safeParse(timestampsToDates(snapshot.data()));
          if (parsed.success) texts.set(id, parsed.data.text);
        });
      }
      return texts;
    },

    async companies(ids) {
      const found = new Map<string, CompanyInfo>();
      if (ids.length === 0) return found;
      const snapshots = await db.getAll(...ids.map((id) => db.doc(PATHS.company(id))));
      snapshots.forEach((snapshot, index) => {
        const id = ids[index];
        if (!id || !snapshot.exists) return;
        const size: unknown = snapshot.get('size');
        const stage: unknown = snapshot.get('stage');
        found.set(id, {
          ...(typeof size === 'string' ? { size } : {}),
          ...(typeof stage === 'string' ? { stage } : {}),
        });
      });
      return found;
    },

    async apply(updates, now) {
      let failed = 0;
      const ready: { jobId: string; data: Record<string, unknown> }[] = [];
      for (const { jobId, patch } of updates) {
        const data = patchUpdate(patch, now);
        if (data) ready.push({ jobId, data });
        else {
          failed += 1;
          log.error('funnel.failed', { step: 'patch_invalid' });
        }
      }
      for (const part of chunks(ready, SCAN.writeBatchOps)) {
        const batch = db.batch();
        for (const { jobId, data } of part) batch.update(db.doc(PATHS.job(jobId)), data);
        try {
          await batch.commit();
        } catch {
          // One bad write (a job deleted since it was read) must not lose the others.
          for (const { jobId, data } of part) {
            try {
              await db.doc(PATHS.job(jobId)).update(data);
            } catch (error) {
              failed += 1;
              log.error('ingest.write_failed', {
                collection: 'jobs',
                writes: 1,
                ...errorFields(error),
              });
            }
          }
        }
      }
      return failed;
    },

    async queueCounts() {
      const [s2, s3] = await Promise.all(
        (['s2', 's3'] as const).map(async (stage) => {
          const snapshot = await jobs.where('next', '==', stage).count().get();
          return snapshot.data().count;
        }),
      );
      return { s2: s2 ?? 0, s3: s3 ?? 0 };
    },

    async saveFullText(jobId, text, now) {
      const batch = db.batch();
      batch.set(db.doc(PATHS.jobDescription(jobId)), {
        text,
        kind: 'full',
        sourceId: 'reed',
        fetchedAt: now,
        schemaVersion: 1,
      });
      batch.update(db.doc(PATHS.job(jobId)), { descriptionKind: 'full', updatedAt: now });
      await batch.commit();
    },

    async reedQuota() {
      const snapshot = await db.doc(PATHS.source('reed')).get();
      const parsed = QuotaSchema.safeParse(timestampsToDates(snapshot.get('quota')));
      return parsed.success ? parsed.data : undefined;
    },

    async reedPauses() {
      const snapshot = await db.doc(PATHS.source('reed')).get();
      const parsed = SourceHealthSchema.shape.pausedHosts.safeParse(
        timestampsToDates(snapshot.get('pausedHosts')),
      );
      return parsed.success
        ? parsed.data.map(({ host, until }) => ({ host, until: until.getTime() }))
        : [];
    },

    async saveReedQuota(quota) {
      await db.doc(PATHS.source('reed')).set({ quota: { ...quota } }, { merge: true });
    },
  };
}
