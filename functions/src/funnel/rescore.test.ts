import type { Run } from '@hireframe/shared';
import { HttpsError } from 'firebase-functions/https';
import { describe, expect, it } from 'vitest';

import type { LockResult } from '../scan/run.js';
import { rescoreHandler, runRescore, type RescoreDeps } from './rescore.js';
import type { FunnelOutcome } from './run.js';
import { TEST_NOW } from './testing.js';

const OUTCOME: FunnelOutcome = {
  perStage: {
    s1: { in: 0, passed: 0, skipped: 0, byRule: {} },
    s2: {
      in: 0,
      passed: 0,
      skipped: 0,
      expired: 0,
      review: 0,
      queued: 0,
      costPence: 0,
      durationMs: 0,
    },
    hydrate: { attempted: 0, ok: 0, failed: 0 },
    s3: {
      in: 0,
      apply: 0,
      near_miss: 0,
      wildcard: 0,
      skip: 0,
      expired: 0,
      review: 0,
      queued: 0,
      drift: 0,
      recomputed: 4,
      costPence: 0,
      durationMs: 0,
    },
    rescore: { jobs: 5, s1Changed: 1, recomputed: 2, queuedS2: 0, queuedS3: 0, unchanged: 2 },
  },
  budget: { leasePence: 24, usedPence: 0 },
  flags: [],
  costPence: 0,
  summary: {
    s1: { passed: 0, skipped: 0 },
    s2: { passed: 0, skipped: 0 },
    s3: { apply: 0, near_miss: 0, wildcard: 0, skip: 0 },
    review: 0,
    queued: { s2: 0, s3: 0 },
    costPence: 0,
  },
  failedWrites: 0,
  sweepFailed: false,
};

function store(lock: LockResult = { ok: true }) {
  const runs = new Map<string, Run>();
  const calls = { releases: 0, cooldown: -1 };
  const value: RescoreDeps['store'] = {
    newRunId: () => 'r1',
    acquireLock: (_id, _now, cooldownMs) => {
      calls.cooldown = cooldownMs;
      return Promise.resolve(lock);
    },
    releaseLock: () => {
      calls.releases += 1;
      return Promise.resolve();
    },
    createRun: (id, run) => Promise.resolve(void runs.set(id, run)),
    finishRun: (id, run) => Promise.resolve(void runs.set(id, run)),
  };
  return { value, runs, calls };
}

describe('runRescore', () => {
  it('re-scores the last 14 days under the lock, with no cooldown, and records a rescore run', async () => {
    const memory = store();
    let since: Date | undefined;
    const result = await runRescore({
      store: memory.value,
      funnel: (input) => {
        since = input.rescoreSince;
        return Promise.resolve(OUTCOME);
      },
      now: () => TEST_NOW,
    });
    expect(memory.calls.cooldown).toBe(0);
    expect(since?.toISOString()).toBe('2026-09-21T08:00:00.000Z');
    expect(result).toMatchObject({
      status: 'completed',
      runId: 'r1',
      counts: { jobs: 5, s1Changed: 1 },
    });
    expect(memory.runs.get('r1')).toMatchObject({
      trigger: 'rescore',
      status: 'succeeded',
      perStage: { rescore: { recomputed: 2 } },
    });
    expect(memory.calls.releases).toBe(1);
  });

  it('refuses while a scan runs', async () => {
    const memory = store({ ok: false, reason: 'running' });
    const result = await runRescore({
      store: memory.value,
      funnel: () => Promise.resolve(OUTCOME),
      now: () => TEST_NOW,
    });
    expect(result).toEqual({ status: 'busy' });
    expect(memory.runs.size).toBe(0);
  });

  it('marks the run failed and unlocks when the funnel throws', async () => {
    const memory = store();
    await expect(
      runRescore({
        store: memory.value,
        funnel: () => Promise.reject(new Error('x')),
        now: () => TEST_NOW,
      }),
    ).rejects.toThrow('x');
    expect(memory.runs.get('r1')?.status).toBe('failed');
    expect(memory.calls.releases).toBe(1);
  });
});

describe('rescoreHandler', () => {
  it('rejects unexpected input and maps busy to failed-precondition', async () => {
    await expect(
      rescoreHandler({ days: 30 }, () => Promise.resolve({ status: 'busy' })),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    const error: unknown = await rescoreHandler({}, () =>
      Promise.resolve({ status: 'busy' }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpsError);
    expect(error).toMatchObject({ code: 'failed-precondition' });
  });
});
