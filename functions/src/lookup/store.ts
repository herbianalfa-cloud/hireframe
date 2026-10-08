import {
  COLLECTIONS,
  JobSchema,
  PATHS,
  type Job,
  type JobDescription,
  type WaitState,
} from '@hireframe/shared';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

import type { Attachment } from '../funnel/attach.js';
import type { JobPatch } from '../funnel/judgement.js';
import { patchUpdate } from '../funnel/store.js';
import { errorFields, log } from '../log.js';
import { timestampsToDates } from '../timestamps.js';

/**
 * Admin SDK reads and writes for Lookup (ADR-049). A job Lookup creates is written whole; every
 * later write follows a model call that ran outside the scan lock, so it is a transaction with a
 * precondition: the job must still be where Lookup left it. If a scan or re-score moved it, the
 * write is dropped and counted, and the job keeps whichever judgement landed first.
 */

/** Where Lookup left the job. A mismatch means someone else moved it. */
export interface Precondition {
  stage: Job['stage'];
  next: WaitState | null;
  /** The job's `judgedAt` when Lookup read it; absent means it had none. */
  judgedAt?: Date;
  /** For a claimed description: the claim time, which must still be on the job. */
  describingAt?: Date;
}

const sameTime = (a: Date | undefined, b: Date | undefined): boolean =>
  a?.getTime() === b?.getTime();

export function matchesPrecondition(job: Job, pre: Precondition): boolean {
  return (
    job.stage === pre.stage &&
    (job.next ?? null) === pre.next &&
    sameTime(job.judgedAt, pre.judgedAt) &&
    (pre.describingAt === undefined || sameTime(job.describingAt, pre.describingAt))
  );
}

export interface JobChange {
  patch: JobPatch;
  /** A board posting's text, source and keys, written in the same transaction. */
  attach?: Attachment;
  /** Removes the description claim. */
  describingAt?: 'clear';
  /** The watched company a board search matched, for a job that had none. */
  companyId?: string;
}

export type CommitResult = 'applied' | 'dropped' | 'missing';

export interface NewJob {
  id: string;
  job: Job;
  description: JobDescription;
}

export interface LookupStore {
  newJobId(): string;
  /** Writes new jobs with their descriptions; returns the IDs whose write failed (logged). */
  createJobs(items: readonly NewJob[]): Promise<string[]>;
  /** Writes `change` only if the job still matches `pre`. */
  commit(jobId: string, pre: Precondition, change: JobChange, now: Date): Promise<CommitResult>;
  /**
   * Takes a job waiting for a description (`next: 'description'`, or a stale earlier claim),
   * setting `next: null` and `describingAt: now`. Null when the job isn't available.
   */
  claimDescription(jobId: string, now: Date, staleMs: number): Promise<Job | null>;
  /** The pasted text becomes the job's full description. */
  saveDescription(jobId: string, description: JobDescription, now: Date): Promise<void>;
}

export function firestoreLookupStore(db: Firestore): LookupStore {
  const jobs = db.collection(COLLECTIONS.jobs);

  return {
    newJobId: () => jobs.doc().id,

    async createJobs(items) {
      const failed: string[] = [];
      for (const item of items) {
        const batch = db.batch();
        batch.create(db.doc(PATHS.job(item.id)), item.job);
        batch.create(db.doc(PATHS.jobDescription(item.id)), item.description);
        try {
          await batch.commit();
        } catch (error) {
          failed.push(item.id);
          log.error('ingest.write_failed', {
            collection: 'jobs',
            writes: 1,
            ...errorFields(error),
          });
        }
      }
      return failed;
    },

    commit(jobId, pre, change, now) {
      const ref = db.doc(PATHS.job(jobId));
      return db.runTransaction(async (tx): Promise<CommitResult> => {
        const snapshot = await tx.get(ref);
        const parsed = snapshot.exists
          ? JobSchema.safeParse(timestampsToDates(snapshot.data()))
          : null;
        if (!parsed?.success) return 'missing';
        if (!matchesPrecondition(parsed.data, pre)) return 'dropped';
        const data = patchUpdate(change.patch, now);
        if (!data) throw new Error('lookup patch names a field the funnel may not write');
        const { attach } = change;
        tx.update(ref, {
          ...data,
          ...(attach
            ? {
                descriptionKind: 'full',
                ...(attach.addSources.length
                  ? { sources: FieldValue.arrayUnion(...attach.addSources) }
                  : {}),
                ...(attach.addKeys.length
                  ? { keys: FieldValue.arrayUnion(...attach.addKeys) }
                  : {}),
                ...(attach.postedAt ? { postedAt: attach.postedAt } : {}),
              }
            : {}),
          ...(change.companyId ? { companyId: change.companyId } : {}),
          ...(change.describingAt === 'clear' ? { describingAt: FieldValue.delete() } : {}),
        });
        if (attach) tx.set(db.doc(PATHS.jobDescription(jobId)), attach.description);
        return 'applied';
      });
    },

    claimDescription(jobId, now, staleMs) {
      const ref = db.doc(PATHS.job(jobId));
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const parsed = snapshot.exists
          ? JobSchema.safeParse(timestampsToDates(snapshot.data()))
          : null;
        if (!parsed?.success) return null;
        const job = parsed.data;
        const waiting = job.next === 'description';
        // An earlier claim whose function died before finishing: nothing judged it, nothing queued it.
        const abandoned =
          (job.next ?? null) === null &&
          job.describingAt !== undefined &&
          now.getTime() - job.describingAt.getTime() > staleMs &&
          job.judgedAt === undefined;
        if (!waiting && !abandoned) return null;
        tx.update(ref, { next: null, describingAt: now, updatedAt: now });
        return { ...job, next: null, describingAt: now, updatedAt: now };
      });
    },

    async saveDescription(jobId, description, now) {
      const batch = db.batch();
      batch.set(db.doc(PATHS.jobDescription(jobId)), description);
      batch.update(db.doc(PATHS.job(jobId)), { descriptionKind: 'full', updatedAt: now });
      await batch.commit();
    },
  };
}
