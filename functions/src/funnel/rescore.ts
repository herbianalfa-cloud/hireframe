import { RESCORE_DAYS, RescoreInputSchema, type RescoreResult, type Run } from '@hireframe/shared';
import { HttpsError } from 'firebase-functions/https';

import { errorFields, log } from '../log.js';
import type { ScanStore } from '../scan/run.js';
import type { FunnelRunner } from './wiring.js';

/**
 * Re-score (PRD R3, ADR-037): re-judges jobs first seen in the last 14 days under the current
 * criteria. It takes the scan lock (no cooldown), so it never overlaps a scan, and records a run
 * with trigger `rescore`. The funnel does the work: S1 again, verdicts recomputed in code where
 * the prompts haven't changed, model calls only where they have, within the usual run budget.
 */
export interface RescoreDeps {
  store: Pick<ScanStore, 'newRunId' | 'acquireLock' | 'releaseLock' | 'createRun' | 'finishRun'>;
  funnel: FunnelRunner;
  now: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runRescore(deps: RescoreDeps): Promise<RescoreResult | { status: 'busy' }> {
  const { store } = deps;
  const startedAt = deps.now();
  const runId = store.newRunId();
  const lock = await store.acquireLock(runId, startedAt, 0);
  if (!lock.ok) return { status: 'busy' };
  const run: Run = {
    trigger: 'rescore',
    status: 'running',
    startedAt,
    perSource: {},
    perStage: {},
    costPence: 0,
    errors: [],
    schemaVersion: 1,
  };
  try {
    await store.createRun(runId, run);
    log.info('rescore.started', { runId });
    if (lock.recovered) log.warn('scan.recovered', { runId: lock.recovered, code: 'timeout' });
    const rescoreSince = new Date(startedAt.getTime() - RESCORE_DAYS * DAY_MS);
    const outcome = await deps.funnel({ runId, startedAt, rescoreSince });
    const errors = [
      ...(outcome.failedWrites > 0 ? [{ code: 'funnel_write_failed' }] : []),
      ...(outcome.sweepFailed ? [{ code: 'funnel_sweep_failed' }] : []),
    ];
    await store.finishRun(runId, {
      ...run,
      status: errors.length > 0 ? 'partial' : 'succeeded',
      finishedAt: deps.now(),
      perStage: outcome.perStage,
      costPence: outcome.costPence,
      budget: outcome.budget,
      ...(outcome.flags.length ? { flags: outcome.flags } : {}),
      errors,
    });
    const counts = outcome.perStage.rescore ?? {
      jobs: 0,
      s1Changed: 0,
      recomputed: 0,
      queuedS2: 0,
      queuedS3: 0,
      unchanged: 0,
    };
    log.info('rescore.done', { runId, ...counts, costPence: outcome.costPence });
    return { status: 'completed', runId, counts, funnel: outcome.summary };
  } catch (error) {
    log.error('scan.failed', { runId, step: 'rescore', ...errorFields(error) });
    await store
      .finishRun(runId, {
        ...run,
        status: 'failed',
        finishedAt: deps.now(),
        errors: [{ code: 'internal' }],
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await store.releaseLock(runId, deps.now()).catch((error: unknown) => {
      log.error('scan.failed', { step: 'unlock', ...errorFields(error) });
    });
  }
}

/** Input validation and the busy → `failed-precondition` mapping, testable without Firebase. */
export async function rescoreHandler(
  data: unknown,
  rescore: () => Promise<RescoreResult | { status: 'busy' }>,
): Promise<RescoreResult> {
  if (!RescoreInputSchema.safeParse(data ?? {}).success) {
    throw new HttpsError('invalid-argument', 'Unexpected input.');
  }
  const result = await rescore();
  if (result.status === 'busy') {
    throw new HttpsError('failed-precondition', 'A scan is running. Try again when it finishes.');
  }
  return result;
}
