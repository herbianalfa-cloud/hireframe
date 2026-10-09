import { isRunStalled, type DigestState, type Run } from '@hireframe/shared';

import { DIGEST } from '../config.js';

/**
 * Which digest to send (ADR-052). Pure: the caller passes the recent runs and the clock.
 * - ready: the morning run succeeded or was partial (partial adds a notice).
 * - failed: it failed, or it is `running` past the stale limit (it was killed).
 * - in_progress: it is still running, or there is no run yet and it is before 08:15.
 * - missing: no morning run by 08:15.
 */
export type DigestRun = Pick<Run, 'trigger' | 'status' | 'startedAt'> & { id: string };

export interface DigestChoice {
  state: DigestState;
  /** The run the digest reports on; absent when there is none. */
  run?: DigestRun;
  /** The partial run's notice: some sources failed. */
  partial: boolean;
}

interface LondonParts {
  day: string;
  minutes: number;
}

export function londonParts(date: Date): LondonParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return {
    day: `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** A scheduled run that started before noon, London time: the morning run of its day. */
export function isMorningRun(run: Pick<Run, 'trigger' | 'startedAt'>): boolean {
  return (
    run.trigger === 'schedule' &&
    londonParts(run.startedAt).minutes < DIGEST.morningRunBeforeHour * 60
  );
}

/** The newest morning run that started on `day` (runs are newest first). */
export function pickMorningRun<T extends DigestRun>(
  runs: readonly T[],
  day: string,
): T | undefined {
  return runs.find((run) => isMorningRun(run) && londonParts(run.startedAt).day === day);
}

/** The newest morning run from an earlier day than `day`: where "since yesterday" starts. */
export function pickPreviousMorningRun<T extends DigestRun>(
  runs: readonly T[],
  day: string,
): T | undefined {
  return runs.find((run) => isMorningRun(run) && londonParts(run.startedAt).day < day);
}

export function chooseDigest(runs: readonly DigestRun[], day: string, now: Date): DigestChoice {
  const run = pickMorningRun(runs, day);
  if (!run) {
    const clock = londonParts(now);
    // Before 08:15 the run may not have started (the 07:30 trigger can wait several minutes).
    const early = clock.day === day && clock.minutes < DIGEST.missingAfterMinutes;
    return { state: early ? 'in_progress' : 'missing', partial: false };
  }
  if (run.status === 'failed' || isRunStalled(run, now)) {
    return { state: 'failed', run, partial: false };
  }
  if (run.status === 'running') return { state: 'in_progress', run, partial: false };
  return { state: 'ready', run, partial: run.status === 'partial' };
}
