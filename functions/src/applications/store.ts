import {
  ApplicationSchema,
  CvHeaderSchema,
  DOCS,
  EventSchema,
  JobSchema,
  PATHS,
  COLLECTIONS,
  type Application,
  type ApplicationStage,
} from '@hireframe/shared';
import type { Firestore } from 'firebase-admin/firestore';

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
  now: Date;
}

export type CommitResult =
  { ok: true; application: Application; factIds: string[] } | { ok: false; reason: 'lost' };

export interface ApplicationStore {
  getApplication(jobId: string): Promise<Application | null>;
  getJob(jobId: string): Promise<JobForApplication | null>;
  /** `profile/cvHeader` exists and is valid. */
  hasCvHeader(): Promise<boolean>;
  commit(change: Change): Promise<CommitResult>;
  /** Removes the `cvs/{cvId}` documents of a withdrawn application. */
  deleteCvDocs(cvIds: readonly string[]): Promise<void>;
}

export function firestoreApplicationStore(db: Firestore): ApplicationStore {
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
      const snapshot = await db.doc(DOCS.cvHeader).get();
      return (
        snapshot.exists && CvHeaderSchema.safeParse(timestampsToDates(snapshot.data())).success
      );
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
