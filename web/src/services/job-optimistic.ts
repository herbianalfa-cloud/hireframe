import type { ClientJobStatus } from '@hireframe/shared';

import type { FeedbackInput } from './job-writes';
import type { JobView } from './job-read';

/**
 * What a job looks like once an action's write lands, for showing it before the server
 * confirms (ADR-038). Pure: the same fields buildJobStatusWrite / buildJobFeedbackWrite write,
 * with `now` standing in for the server timestamp.
 */

const APPLIED_KEYS = ['appliedAt', 'appliedVerdict'];

function without<T extends object>(value: T, keys: string[]): T {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as T;
}

export function withStatus(view: JobView, to: ClientJobStatus, now: Date): JobView {
  const applied =
    to === 'applied'
      ? { appliedAt: now, ...(view.job.verdict ? { appliedVerdict: view.job.verdict } : {}) }
      : {};
  return {
    id: view.id,
    job: { ...without(view.job, APPLIED_KEYS), status: to, updatedAt: now, ...applied },
    raw: { ...without(view.raw, APPLIED_KEYS), status: to, updatedAt: now, ...applied },
  };
}

export function withFeedback(view: JobView, input: FeedbackInput, now: Date): JobView {
  const verdict = view.job.verdict;
  if (!verdict) return view;
  const note = input.note?.trim();
  const expected = input.agree ? undefined : input.expected;
  const feedback = {
    agree: input.agree,
    verdict,
    ...(note ? { note } : {}),
    ...(expected ? { expected } : {}),
    at: now,
  };
  return {
    id: view.id,
    job: { ...view.job, feedback, updatedAt: now },
    raw: { ...view.raw, feedback, updatedAt: now },
  };
}
