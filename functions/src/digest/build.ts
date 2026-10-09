import {
  DigestResponseSchema,
  type DigestRequest,
  type DigestResponse,
  type DigestVerdict,
} from '@hireframe/shared';

import { DIGEST } from '../config.js';
import { renderDigest, type DigestJobList, type DigestRunSummary } from './render.js';
import { chooseDigest, pickPreviousMorningRun } from './state.js';
import type { DigestStore, StoredDigestRun } from './store.js';

/**
 * Reads what the digest needs and renders it (ADR-052). No model call and no write. A state with
 * nothing to list (in progress, missing) skips the job and source reads.
 */

const NONE: DigestJobList = { jobs: [], total: 0 };

function summarise(run: StoredDigestRun): DigestRunSummary {
  const { s2, s3 } = run.perStage;
  return {
    status: run.status,
    startedAt: run.startedAt,
    ...(s2 ? { s2 } : {}),
    ...(s3 ? { s3 } : {}),
    errors: run.errors.map((error) => ({
      ...(error.sourceId === undefined ? {} : { sourceId: error.sourceId }),
      code: error.code,
    })),
  };
}

export async function buildDigest(
  store: DigestStore,
  request: DigestRequest,
  now: Date,
): Promise<DigestResponse> {
  const runs = await store.recentRuns();
  const choice = chooseDigest(runs, request.day, now);
  const run = choice.run ? runs.find((candidate) => candidate.id === choice.run?.id) : undefined;
  const wantsDetail = choice.state === 'ready' || choice.state === 'failed';

  // "New" means judged since the previous morning run finished (started, if it never recorded a
  // finish), or a day before this one's start when there is no earlier morning run.
  const previous = pickPreviousMorningRun(runs, request.day);
  const since =
    previous?.finishedAt ??
    previous?.startedAt ??
    new Date((run?.startedAt ?? now).getTime() - DIGEST.defaultLookbackMs);

  const list = (verdict: DigestVerdict) =>
    choice.state === 'ready' ? store.jobsSince(verdict, since) : Promise.resolve(NONE);

  const [apply, nearMiss, wildcard, sources, waitingForDescription, spend] = await Promise.all([
    list('apply'),
    list('near_miss'),
    list('wildcard'),
    wantsDetail ? store.sources() : Promise.resolve([]),
    wantsDetail ? store.waitingForDescription() : Promise.resolve(0),
    store.usage(now),
  ]);

  const rendered = renderDigest({
    state: choice.state,
    day: request.day,
    partial: choice.partial,
    ...(run ? { run: summarise(run) } : {}),
    apply,
    nearMiss,
    wildcard,
    sources,
    waitingForDescription,
    spend,
  });
  return DigestResponseSchema.parse({ state: choice.state, ...rendered });
}
