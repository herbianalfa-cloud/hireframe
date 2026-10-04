import type { ClientJobStatus } from '@hireframe/shared';

import { showToast } from '@/lib/toast';
import { withFeedback, withStatus } from '@/services/job-optimistic';
import type { FeedbackInput } from '@/services/job-writes';
import { jobActionErrorMessage, rateJob, setJobStatus, type JobView } from '@/services/jobs';

export type JobAction =
  { kind: 'status'; to: ClientJobStatus } | { kind: 'rate'; input: FeedbackInput };

/** How a screen follows an action without reloading anything. */
export interface JobActionHandlers {
  /** Show this version of the job at once; called again with the old one if the write is refused. */
  onPatch?: ((view: JobView) => void) | undefined;
  /** The server confirmed: refresh anything counted from jobs (tiles, agreement). */
  onCommitted?: (() => void) | undefined;
}

export type JobActionResult =
  { ok: true; view: JobView } | { ok: false; message: string } | { ok: false; busy: true };

const isClientStatus = (status: string): status is ClientJobStatus =>
  ['new', 'saved', 'applied', 'skipped'].includes(status);

/** Jobs with a write in flight, so a second press can't send a write built on stale data. */
const inFlight = new Set<string>();

export function isJobBusy(jobId: string): boolean {
  return inFlight.has(jobId);
}

function statusToast(from: string, to: ClientJobStatus): string {
  if (to === 'saved') return 'Saved';
  if (to === 'applied') return 'Marked applied';
  if (to === 'skipped') return 'Skipped';
  if (from === 'saved') return 'Removed from saved';
  if (from === 'skipped') return 'Skip undone';
  return 'Marked not applied';
}

/**
 * Run one action on a job: show the result at once, write it, roll back if it is refused, and
 * toast when it is confirmed. Status changes offer Undo except out of applied, where going
 * back would stamp a new applied date; a rating has no Undo (the rules can't remove one), it
 * is changed by rating again.
 */
export async function performJobAction(
  view: JobView,
  action: JobAction,
  handlers: JobActionHandlers = {},
  options: { undo?: boolean } = {},
): Promise<JobActionResult> {
  if (inFlight.has(view.id)) return { ok: false, busy: true };
  inFlight.add(view.id);
  const now = new Date();
  const from = view.job.status;
  try {
    const write =
      action.kind === 'status' ? setJobStatus(view, action.to) : rateJob(view, action.input);
    const next =
      action.kind === 'status'
        ? withStatus(view, action.to, now)
        : withFeedback(view, action.input, now);
    handlers.onPatch?.(next);
    try {
      await write;
    } catch (caught) {
      handlers.onPatch?.(view);
      const message = jobActionErrorMessage(caught);
      if (options.undo) showToast({ message, tone: 'error' });
      return { ok: false, message };
    }
    handlers.onCommitted?.();
    if (options.undo) {
      showToast({ message: 'Undone' });
    } else if (action.kind === 'rate') {
      showToast({ message: action.input.agree ? 'Rated 👍' : 'Rated 👎' });
    } else {
      const message = statusToast(from, action.to);
      showToast({
        message,
        ...(isClientStatus(from) && from !== 'applied'
          ? {
              action: {
                label: 'Undo',
                run: () => {
                  void performJobAction(next, { kind: 'status', to: from }, handlers, {
                    undo: true,
                  });
                },
              },
            }
          : {}),
      });
    }
    return { ok: true, view: next };
  } finally {
    inFlight.delete(view.id);
  }
}
