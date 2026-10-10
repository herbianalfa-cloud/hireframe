import {
  ApplicationSchema,
  CvDocSchema,
  CvHeaderSchema,
  DOCS,
  EventSchema,
  JobDescriptionSchema,
  JobSchema,
  PATHS,
  COLLECTIONS,
  FUNNEL_LIMITS,
  generatingApplicationsSpec,
  type Application,
  type ApplicationStage,
  type CvDoc,
  type CvHeader,
  type JobRequirement,
} from '@hireframe/shared';
import type { Firestore, Query } from 'firebase-admin/firestore';

import { log } from '../log.js';
import { manualFactWrites, type NewFact } from '../profile/store.js';
import { timestampsToDates } from '../timestamps.js';
import type { JobForApplication } from './transitions.js';

/**
 * Admin SDK reads and writes for the `application` callable (M7 7D.1). Every write is a
 * transaction that first re-reads `applications/{jobId}` and checks the precondition (its stage,
 * and its attempt) the caller read before; a mismatch writes nothing. A stage change appends an
 * `application_stage` event in the same transaction, so the history can't miss a move.
 */

/** What the caller saw before it decided: the document must still be exactly here. */
export interface Expect {
  stage: ApplicationStage;
  attempt: number;
}

export interface Change {
  jobId: string;
  /** null: no document yet. */
  expect: Expect | null;
  /** Manual facts written in the same transaction, marked `answerFor` this job. */
  facts?: readonly NewFact[];
  /**
   * The document to write, from the one read inside the transaction and the IDs the facts got;
   * null when the move no longer applies (a question was answered meanwhile).
   */
  build: (current: Application | null, factIds: string[]) => Application | null;
  /** The `cvs/{cvId}` document written in the same transaction (the worker's ready move). */
  cvDoc?: { cvId: string; doc: CvDoc };
  now: Date;
}

/** What the CV prompt reads of a job: the untrusted posting and the S3 analysis of it. */
export interface JobForCv {
  title: string;
  company: string;
  location: string;
  remote: string;
  /** The stored description, cut to what S3 reads. Empty when none is stored. */
  description: string;
  requirements: JobRequirement[];
  talkingPoints: string[];
}

export type CommitResult =
  { ok: true; application: Application; factIds: string[] } | { ok: false; reason: 'lost' };

export interface ApplicationStore {
  getApplication(jobId: string): Promise<Application | null>;
  getJob(jobId: string): Promise<JobForApplication | null>;
  /** `profile/cvHeader` exists and is valid. */
  hasCvHeader(): Promise<boolean>;
  /** `profile/cvHeader`, parsed with `CvHeaderSchema`; null when missing or invalid. */
  getCvHeader(): Promise<CvHeader | null>;
  /**
   * The applications at `generating`, oldest `stageAt` first, at most `limit`. Reads at most
   * `readLimit` documents (the query has no ordering) and skips invalid ones.
   */
  listGenerating(limit: number, readLimit: number): Promise<Application[]>;
  /** The job as the CV prompt needs it; null when it is missing, invalid or has no deep read. */
  getJobForCv(jobId: string): Promise<JobForCv | null>;
  commit(change: Change): Promise<CommitResult>;
  /** Removes the `cvs/{cvId}` documents of a withdrawn application. */
  deleteCvDocs(cvIds: readonly string[]): Promise<void>;
}

export function firestoreApplicationStore(db: Firestore): ApplicationStore {
  async function readHeader(): Promise<CvHeader | null> {
    const snapshot = await db.doc(DOCS.cvHeader).get();
    if (!snapshot.exists) return null;
    const parsed = CvHeaderSchema.safeParse(timestampsToDates(snapshot.data()));
    return parsed.success ? parsed.data : null;
  }

  return {
    async getApplication(jobId) {
      const snapshot = await db.doc(PATHS.application(jobId)).get();
      if (!snapshot.exists) return null;
      const parsed = ApplicationSchema.safeParse(timestampsToDates(snapshot.data()));
      if (!parsed.success) throw new Error('application document is invalid');
      return parsed.data;
    },

    async getJob(jobId) {
      const snapshot = await db.doc(PATHS.job(jobId)).get();
      if (!snapshot.exists) return null;
      const parsed = JobSchema.safeParse(timestampsToDates(snapshot.data()));
      if (!parsed.success) return null;
      const { title, company, verdict, deep } = parsed.data;
      return {
        title,
        company,
        ...(verdict ? { verdict } : {}),
        ...(deep ? { deep } : {}),
      };
    },

    async hasCvHeader() {
      return (await readHeader()) !== null;
    },

    getCvHeader: readHeader,

    async listGenerating(limit, readLimit) {
      let query: Query = db.collection(generatingApplicationsSpec.collection);
      for (const filter of generatingApplicationsSpec.filters) {
        query = query.where(filter.field, filter.op, filter.value);
      }
      const snapshot = await query.limit(readLimit).get();
      const found: Application[] = [];
      let invalid = 0;
      for (const doc of snapshot.docs) {
        const parsed = ApplicationSchema.safeParse(timestampsToDates(doc.data()));
        if (parsed.success) found.push(parsed.data);
        else invalid += 1;
      }
      if (invalid > 0)
        log.warn('store.invalid_doc', { collection: 'applications', count: invalid });
      return found
        .sort((a, b) => a.stageAt.getTime() - b.stageAt.getTime())
        .slice(0, Math.max(0, limit));
    },

    async getJobForCv(jobId) {
      const [jobSnapshot, descriptionSnapshot] = await Promise.all([
        db.doc(PATHS.job(jobId)).get(),
        db.doc(PATHS.jobDescription(jobId)).get(),
      ]);
      if (!jobSnapshot.exists) return null;
      const job = JobSchema.safeParse(timestampsToDates(jobSnapshot.data()));
      if (!job.success || !job.data.deep) return null;
      const description = descriptionSnapshot.exists
        ? JobDescriptionSchema.safeParse(timestampsToDates(descriptionSnapshot.data()))
        : null;
      const { title, company, location, remote, deep } = job.data;
      return {
        title,
        company,
        location,
        remote,
        description: description?.success
          ? description.data.text.slice(0, FUNNEL_LIMITS.s3Description)
          : '',
        requirements: deep.requirements,
        talkingPoints: deep.talkingPoints,
      };
    },

    commit(change) {
      const ref = db.doc(PATHS.application(change.jobId));
      return db.runTransaction(async (tx): Promise<CommitResult> => {
        const snapshot = await tx.get(ref);
        let current: Application | null = null;
        if (snapshot.exists) {
          const parsed = ApplicationSchema.safeParse(timestampsToDates(snapshot.data()));
          if (!parsed.success) throw new Error('application document is invalid');
          current = parsed.data;
        }
        const { expect } = change;
        const here = current ? { stage: current.stage, attempt: current.attempt } : null;
        if (here?.stage !== expect?.stage || here?.attempt !== expect?.attempt) {
          return { ok: false, reason: 'lost' };
        }
        const { ids, writes } = manualFactWrites(
          db,
          change.facts ?? [],
          change.now,
          change.facts?.length ? { jobId: change.jobId } : undefined,
        );
        const next = change.build(current, ids);
        if (!next) return { ok: false, reason: 'lost' };
        const valid = ApplicationSchema.parse(next);
        for (const write of writes) tx.create(db.doc(write.path), write.data);
        if (change.cvDoc) {
          tx.set(db.doc(PATHS.cv(change.cvDoc.cvId)), CvDocSchema.parse(change.cvDoc.doc));
        }
        tx.set(ref, valid);
        const from = current?.stage ?? null;
        if (from !== valid.stage) {
          const event = EventSchema.parse({
            type: 'application_stage',
            jobId: change.jobId,
            from,
            to: valid.stage,
            at: change.now,
            schemaVersion: 1,
          });
          tx.create(db.collection(COLLECTIONS.events).doc(), event);
        }
        return { ok: true, application: valid, factIds: ids };
      });
    },

    async deleteCvDocs(cvIds) {
      const batch = db.batch();
      for (const cvId of cvIds) batch.delete(db.doc(PATHS.cv(cvId)));
      await batch.commit();
    },
  };
}
