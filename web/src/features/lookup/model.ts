import type {
  LookupDescribeResult,
  LookupOutcome,
  LookupQueueReason,
  Verdict,
} from '@hireframe/shared';

import { STAGE_NAMES, VERDICT_LABELS } from '@/features/jobs/labels';

/** Words for what Lookup did with a job. Colour is never the only signal (web/DESIGN.md). */

const QUEUE_REASONS: Readonly<Record<LookupQueueReason, string>> = {
  daily_cap: "today's Lookup limit was reached",
  monthly_cap: "this month's AI limit was reached",
  no_profile: 'there is no profile to judge against yet',
  time: 'there was not enough time',
  error: 'the model call failed',
};

function skipWords(stage: 's1' | 's2', ruleId?: string, note?: string): string {
  const rule = ruleId ? ` (rule ${ruleId})` : '';
  return note ? `${STAGE_NAMES[stage]}${rule}: ${note}` : `${STAGE_NAMES[stage]}${rule} said no`;
}

export function verdictWords(verdict: Verdict): string {
  return VERDICT_LABELS[verdict];
}

/** One job's outcome from `add`, in words. */
export function outcomeText(outcome: LookupOutcome): string {
  switch (outcome.status) {
    case 'seen':
      return 'Already seen. Nothing was added.';
    case 'judged':
      return `Judged: ${verdictWords(outcome.verdict)}`;
    case 'skipped':
      return `Skipped. ${skipWords(outcome.stage, outcome.ruleId, outcome.note)}`;
    case 'needs_description':
      return 'Added. It needs a description: paste it below.';
    case 'queued':
      return `Added and queued for the next scan, because ${QUEUE_REASONS[outcome.reason]}.`;
    case 'review':
      return 'Added, but the model could not judge it. It is up for review.';
    case 'not_found':
      return 'Not found on that job board, or not a supported board.';
    case 'invalid':
      return "Couldn't be added.";
  }
}

/** The result of judging a pasted description. */
export function describeText(result: LookupDescribeResult): string {
  switch (result.status) {
    case 'judged':
      return `Judged: ${verdictWords(result.verdict)}`;
    case 'skipped':
      return `Skipped. ${skipWords(result.stage, result.ruleId, result.note)}`;
    case 'queued':
      return `Saved. The next scan will judge it, because ${QUEUE_REASONS[result.reason]}.`;
    case 'review':
      return 'Saved, but the model could not judge it. It is up for review.';
    case 'refused':
      return "This job isn't waiting for a description any more.";
  }
}

/** The cap note after an add, or null when no cap stopped anything. */
export function capText(cap: 'daily' | 'monthly' | null): string | null {
  if (cap === 'daily') {
    return "Lookup has reached today's spending limit. The jobs it couldn't judge go first in the next scan.";
  }
  if (cap === 'monthly') {
    return "This month's AI limit is reached. The jobs it couldn't judge go first in the next scan.";
  }
  return null;
}

/** A scan or import held the lock: say when to try again, rounded up to whole minutes. */
export function busyText(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `A scan is running; adding will work in about ${String(minutes)} min. Checking links still works meanwhile.`;
}

/** Where a stored job stands, for a "Seen" line: the stage it stopped at, in words. */
export function stageText(stage: 's0' | 's1' | 's2' | 's3'): string {
  return stage === 's0' ? 'Not judged yet' : `Stopped at ${STAGE_NAMES[stage].toLowerCase()}`;
}
