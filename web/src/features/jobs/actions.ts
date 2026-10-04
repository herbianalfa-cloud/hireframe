import type { ClientJobStatus } from '@hireframe/shared';

import { withFeedback, withoutFeedback, withStatus } from '@/services/job-optimistic';
import type { FeedbackInput } from '@/services/job-writes';
import {
  jobActionErrorMessage,
  rateJob,
  setJobStatus,
  unrateJob,
  type JobView,
} from '@/services/jobs';

export type JobAction =
  | { kind: 'status'; to: ClientJobStatus }
  | { kind: 'rate'; input: FeedbackInput }
  | { kind: 'unrate' };

/** How a screen follows an action without reloading anything. */
export interface JobActionHandlers {
  /** Show this version of the job at once; called again with the old one if the write is refused. */
  onPatch?: ((view: JobView) => void) | undefined;
  /** The server confirmed: refresh anything counted from jobs (tiles, agreement). */
  onCommitted?: (() => void) | undefined;
}

export type JobActionResult =
  { ok: true; view: JobView } | { ok: false; message: string } | { ok: false; busy: true };

/** Jobs with a write in flight, so a second press can't send a write built on stale data. */
const inFlight = new Set<string>();

export function isJobBusy(jobId: string): boolean {
  return inFlight.has(jobId);
}

/**
 * Run one action on a job: show the result at once, write it, and roll back if it is refused.
 * The caller shows the returned error.
 */
export async function performJobAction(
  view: JobView,
  action: JobAction,
  handlers: JobActionHandlers = {},
): Promise<JobActionResult> {
  if (inFlight.has(view.id)) return { ok: false, busy: true };
  inFlight.add(view.id);
  const now = new Date();
  try {
    const write =
      action.kind === 'status'
        ? setJobStatus(view, action.to)
        : action.kind === 'rate'
          ? rateJob(view, action.input)
          : unrateJob(view);
    const next =
      action.kind === 'status'
        ? withStatus(view, action.to, now)
        : action.kind === 'rate'
          ? withFeedback(view, action.input, now)
          : withoutFeedback(view, now);
    handlers.onPatch?.(next);
    try {
      await write;
    } catch (caught) {
      handlers.onPatch?.(view);
      const message = jobActionErrorMessage(caught);
      return { ok: false, message };
    }
    handlers.onCommitted?.();
    return { ok: true, view: next };
  } finally {
    inFlight.delete(view.id);
  }
}
