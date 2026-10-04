import {
  CLIENT_JOB_STATUSES,
  JOB_LIMITS,
  VERDICTS,
  type ClientJobStatus,
  type JobStatus,
  type Verdict,
} from '@hireframe/shared';
import { deleteField, type DocumentData, type FieldValue } from 'firebase/firestore';

/**
 * Pure builders for the job actions firestore.rules allow (ADR-038): set a status, mark applied,
 * rate a verdict. Each returns the job update and the create-only `events` document written in
 * the same batch. They work on the raw Firestore data, and tests/rules/jobs.rules.test.ts runs
 * them against the real rules.
 */

export interface JobActionWrite {
  /** Fields to merge into `jobs/{jobId}` with `updateDoc`. */
  update: DocumentData;
  /** The `events/{id}` document to create in the same batch. */
  event: DocumentData;
}

export interface FeedbackInput {
  agree: boolean;
  note?: string | undefined;
  /** What the verdict should have been; only for a 👎. */
  expected?: Verdict | undefined;
}

const isVerdict = (value: unknown): value is Verdict =>
  typeof value === 'string' && (VERDICTS as readonly string[]).includes(value);

const isClientStatus = (value: unknown): value is ClientJobStatus =>
  typeof value === 'string' && (CLIENT_JOB_STATUSES as readonly string[]).includes(value);

/**
 * Move a job to `to`. Marking applied stamps `appliedAt` (server time) and the verdict it was
 * applied on; leaving applied clears both.
 */
export function buildJobStatusWrite(
  jobId: string,
  raw: DocumentData,
  to: ClientJobStatus,
  serverNow: FieldValue,
): JobActionWrite {
  const from = raw.status as JobStatus;
  if (!isClientStatus(from)) throw new Error('This job’s status can’t be changed from the app.');
  if (from === to) throw new Error('The job already has that status.');
  const verdict = isVerdict(raw.verdict) ? raw.verdict : undefined;
  const update: DocumentData = { status: to, updatedAt: serverNow };
  if (to === 'applied') {
    update.appliedAt = serverNow;
    if (verdict) update.appliedVerdict = verdict;
  } else {
    update.appliedAt = deleteField();
    update.appliedVerdict = deleteField();
  }
  return {
    update,
    event: {
      type: 'job_status',
      jobId,
      from,
      to,
      ...(verdict ? { verdict } : {}),
      at: serverNow,
      schemaVersion: 1,
    },
  };
}

/** 👍/👎 on a judged job. The rating names the verdict it judged, so a re-score can't change it. */
export function buildJobFeedbackWrite(
  jobId: string,
  raw: DocumentData,
  input: FeedbackInput,
  serverNow: FieldValue,
): JobActionWrite {
  if (!isVerdict(raw.verdict)) throw new Error('Only a judged job can be rated.');
  const verdict = raw.verdict;
  const note = input.note?.trim();
  if (note && note.length > JOB_LIMITS.feedbackNote) {
    throw new Error(`The note can be up to ${String(JOB_LIMITS.feedbackNote)} characters.`);
  }
  const expected = input.agree ? undefined : input.expected;
  if (expected === verdict) throw new Error('Pick a different verdict from the one it gave.');
  return {
    update: {
      feedback: {
        agree: input.agree,
        verdict,
        ...(note ? { note } : {}),
        ...(expected ? { expected } : {}),
        at: serverNow,
      },
      updatedAt: serverNow,
    },
    event: {
      type: 'job_feedback',
      jobId,
      agree: input.agree,
      verdict,
      ...(expected ? { expected } : {}),
      at: serverNow,
      schemaVersion: 1,
    },
  };
}

/**
 * Take a rating back. Deletes the whole `feedback` field and records a `job_feedback_removed`
 * event naming the rating that went, so a metric recomputed from events can cancel it.
 */
export function buildJobFeedbackRemovalWrite(
  jobId: string,
  raw: DocumentData,
  serverNow: FieldValue,
): JobActionWrite {
  const feedback: unknown = raw.feedback;
  if (
    typeof feedback !== 'object' ||
    feedback === null ||
    !('agree' in feedback) ||
    typeof feedback.agree !== 'boolean' ||
    !('verdict' in feedback) ||
    !isVerdict(feedback.verdict)
  ) {
    throw new Error('This job has no rating to remove.');
  }
  return {
    update: { feedback: deleteField(), updatedAt: serverNow },
    event: {
      type: 'job_feedback_removed',
      jobId,
      agree: feedback.agree,
      verdict: feedback.verdict,
      at: serverNow,
      schemaVersion: 1,
    },
  };
}
