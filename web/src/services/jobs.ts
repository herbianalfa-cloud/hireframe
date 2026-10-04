import {
  COLLECTIONS,
  JobDescriptionSchema,
  JobSchema,
  PATHS,
  type ClientJobStatus,
  type Job,
  type JobDescription,
  type JobStatus,
  type Verdict,
} from '@hireframe/shared';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  startAfter,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';

import { getFirebase } from './firebase';
import {
  buildJobFeedbackWrite,
  buildJobStatusWrite,
  type FeedbackInput,
  type JobActionWrite,
} from './job-writes';
import { errorCode, logError } from './log';
import { specConstraints, type QuerySpec } from './query-spec';
import { listen, type LiveState, type Unsubscribe } from './profile';
import { isTransient, withRetry, withTimeout } from './resilience';
import { timestampsToDates } from './timestamps';

/**
 * Job services (PRD R7, ADR-038). Components use these, never Firebase directly.
 * - Reads are zod-parsed; documents that fail the schema are skipped and counted.
 * - Actions (status, applied, 👍/👎) are batches built by job-writes.ts and enforced by
 *   firestore.rules. Job text is untrusted: it is returned as data and never interpreted here.
 */

export interface JobView {
  id: string;
  job: Job;
  /** The document as stored, which the action builders read. */
  raw: DocumentData;
}

/** Filters the Jobs screen offers; each combination has an index (firestore.indexes.json). */
export interface JobFilters {
  verdict?: Verdict;
  status?: JobStatus;
  /** Jobs whose model output was unusable and wait for a human (`review.stage` set). */
  needsReview?: boolean;
}

export const JOBS_PAGE_SIZE = 25;
const WRITE_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 15_000;

export function parseJobs(docs: readonly QueryDocumentSnapshot[]): {
  jobs: JobView[];
  invalid: number;
} {
  const jobs: JobView[] = [];
  let invalid = 0;
  for (const item of docs) {
    const raw = item.data();
    const parsed = JobSchema.safeParse(timestampsToDates(raw));
    if (parsed.success) jobs.push({ id: item.id, job: parsed.data, raw });
    else invalid++;
  }
  if (invalid > 0) logError('jobs.invalid', { count: invalid });
  return { jobs, invalid };
}

/** The query for a filter set: newest judged first. */
export function jobFilterSpec(filters: JobFilters): QuerySpec {
  return {
    collection: COLLECTIONS.jobs,
    filters: [
      ...(filters.verdict ? [{ field: 'verdict', op: '==' as const, value: filters.verdict }] : []),
      ...(filters.status ? [{ field: 'status', op: '==' as const, value: filters.status }] : []),
      ...(filters.needsReview
        ? [{ field: 'review.stage', op: 'in' as const, value: ['s2', 's3'] }]
        : []),
    ],
    orderBy: [{ field: 'judgedAt', direction: 'desc' }],
  };
}

export interface JobsPage {
  jobs: JobView[];
  invalid: number;
  /** Pass back to load the next page; null when there is no more. */
  cursor: QueryDocumentSnapshot | null;
}

/** One page of jobs. Read the next page by passing the previous page's `cursor`. */
export async function loadJobsPage(
  filters: JobFilters,
  cursor: QueryDocumentSnapshot | null = null,
): Promise<JobsPage> {
  const { db } = await getFirebase();
  const constraints = [
    ...specConstraints(jobFilterSpec(filters)),
    ...(cursor ? [startAfter(cursor)] : []),
    limit(JOBS_PAGE_SIZE),
  ];
  const snapshot = await withRetry(
    () =>
      withTimeout(
        getDocs(query(collection(db, COLLECTIONS.jobs), ...constraints)),
        READ_TIMEOUT_MS,
        'jobs page',
      ),
    { label: 'jobs.page', isRetryable: isTransient },
  );
  const { jobs, invalid } = parseJobs(snapshot.docs);
  const last = snapshot.docs.at(-1);
  return {
    jobs,
    invalid,
    cursor: snapshot.docs.length === JOBS_PAGE_SIZE && last ? last : null,
  };
}

/** One job, live, so an action shows at once. `data` is null when it doesn't exist. */
export function watchJob(
  jobId: string,
  callback: (state: LiveState<JobView | null>) => void,
): Unsubscribe {
  callback({ status: 'loading' });
  return listen(
    async () => {
      const { db } = await getFirebase();
      return onSnapshot(
        doc(db, PATHS.job(jobId)),
        (snapshot) => {
          if (!snapshot.exists()) {
            callback({ status: 'ready', data: null, invalid: 0 });
            return;
          }
          const raw = snapshot.data();
          const parsed = JobSchema.safeParse(timestampsToDates(raw));
          if (parsed.success) {
            callback({
              status: 'ready',
              data: { id: snapshot.id, job: parsed.data, raw },
              invalid: 0,
            });
          } else {
            logError('jobs.invalid', { count: 1 });
            callback({ status: 'error', message: "This job's data couldn't be read." });
          }
        },
        (error) => {
          logError('jobs.job_failed', { code: error.code });
          callback({ status: 'error', message: "Couldn't load this job. Reload to try again." });
        },
      );
    },
    (message) => {
      callback({ status: 'error', message });
    },
  );
}

/** The stored description text: untrusted, so show it as plain text only. */
export async function loadJobDescription(jobId: string): Promise<JobDescription | null> {
  const { db } = await getFirebase();
  const snapshot = await withRetry(
    () =>
      withTimeout(getDoc(doc(db, PATHS.jobDescription(jobId))), READ_TIMEOUT_MS, 'job description'),
    { label: 'jobs.description', isRetryable: isTransient },
  );
  if (!snapshot.exists()) return null;
  const parsed = JobDescriptionSchema.safeParse(timestampsToDates(snapshot.data()));
  if (!parsed.success) {
    logError('jobs.description_invalid', {});
    return null;
  }
  return parsed.data;
}

async function commitAction(jobId: string, write: JobActionWrite): Promise<void> {
  const { db } = await getFirebase();
  const batch = writeBatch(db);
  batch.update(doc(db, PATHS.job(jobId)), write.update);
  batch.set(doc(collection(db, COLLECTIONS.events)), write.event);
  await withRetry(() => withTimeout(batch.commit(), WRITE_TIMEOUT_MS, 'job action'), {
    label: 'jobs.action',
    // A committed-but-timed-out batch must not be sent twice: only retry clear rejections.
    isRetryable: (error) => errorCode(error) === 'unavailable',
  });
}

/** Save, skip, mark applied, or put back to new. */
export function setJobStatus(view: JobView, to: ClientJobStatus): Promise<void> {
  return commitAction(view.id, buildJobStatusWrite(view.id, view.raw, to, serverTimestamp()));
}

/** 👍/👎 on the verdict. The rules reject it if a re-score changed the verdict meanwhile. */
export function rateJob(view: JobView, input: FeedbackInput): Promise<void> {
  return commitAction(view.id, buildJobFeedbackWrite(view.id, view.raw, input, serverTimestamp()));
}

export function jobActionErrorMessage(error: unknown): string {
  if (errorCode(error) === 'permission-denied') {
    return 'This job changed since you opened it. Reload and try again.';
  }
  if (error instanceof Error && !errorCode(error)) return error.message;
  return "Couldn't save. Check your connection and try again.";
}
