import type { SenderStats, SourceHealth, SourceRunCounts } from '@hireframe/shared';

import { ALERTS } from '../config.js';
import { nextSourceHealth } from '../scan/run.js';

/**
 * `sources/email` after one ingest request (ADR-047), pure: `requests` is messages, `fetched` the
 * jobs parsed, `invalid` the unparsed messages, and `bySender` keeps running totals per sender
 * domain (at most 20; the rest count under `other`). Counts only, never a subject or address.
 */

export interface SenderDelta {
  messages: number;
  jobs: number;
  unparsed: number;
  unverifiedLinks: number;
}

export interface IngestTally {
  messages: number;
  jobs: number;
  new: number;
  merged: number;
  duplicate: number;
  unparsed: number;
  deferred: number;
  durationMs: number;
  bySender: ReadonlyMap<string, SenderDelta>;
}

export const OTHER_SENDERS = 'other';

export function mergeSenders(
  previous: Readonly<Record<string, SenderStats>> | undefined,
  deltas: ReadonlyMap<string, SenderDelta>,
  now: Date,
): Record<string, SenderStats> {
  const next: Record<string, SenderStats> = { ...previous };
  for (const [domain, delta] of deltas) {
    const listed = Object.keys(next).filter((key) => key !== OTHER_SENDERS).length;
    const key = domain in next || listed < ALERTS.maxSenderDomains ? domain : OTHER_SENDERS;
    const was = next[key] ?? { messages: 0, jobs: 0, unparsed: 0, unverifiedLinks: 0, lastAt: now };
    next[key] = {
      messages: was.messages + delta.messages,
      jobs: was.jobs + delta.jobs,
      unparsed: was.unparsed + delta.unparsed,
      unverifiedLinks: was.unverifiedLinks + delta.unverifiedLinks,
      lastAt: now,
    };
  }
  return next;
}

export function nextEmailHealth(
  previous: SourceHealth | undefined,
  tally: IngestTally,
  now: Date,
): SourceHealth {
  const handled = tally.messages - tally.duplicate;
  // Nothing was usable (every new message unparsed or deferred): failing. Some: degraded.
  const status: SourceRunCounts['status'] =
    handled > 0 && tally.unparsed + tally.deferred === handled
      ? 'failing'
      : tally.unparsed + tally.deferred > 0
        ? 'degraded'
        : 'ok';
  const counts: SourceRunCounts = {
    status,
    fetched: tally.jobs,
    invalid: tally.unparsed,
    new: tally.new,
    duplicate: tally.duplicate,
    merged: tally.merged,
    errors: tally.deferred,
    requests: tally.messages,
    durationMs: tally.durationMs,
    ...(tally.unparsed > 0
      ? { errorCode: 'unparsed' }
      : tally.deferred > 0
        ? { errorCode: 'deferred' }
        : {}),
  };
  const health = nextSourceHealth(previous, counts, now, {});
  return {
    ...health,
    bySender: mergeSenders(previous?.bySender, tally.bySender, now),
  };
}
