import type { TokenCounts } from '@hireframe/shared';

import { RunBudgetExceededError } from './errors.js';
import type { LeaseSettlement, UsageStore } from './usage-store.js';

/**
 * A run's spend lease, in memory (ADR-032). The run reserves its budget on `usage/{month}` once;
 * every `llm.call()` in the run then reserves its worst case here and settles its actual cost
 * here, with no Firestore transaction per call. At the end the run settles the lease in one
 * transaction (`LeaseStore.settleLease`). In-flight worst cases count, so the run's actual spend
 * can never pass the lease.
 */
export type LeaseStage = 's2' | 's3';

export interface RunLease {
  readonly grantedPence: number;
  /** The `UsageStore` `llm.call()` uses for one stage's calls. */
  usage(stage: LeaseStage): UsageStore;
  usedPence(stage?: LeaseStage): number;
  /** Calls reserved and not yet settled, in `stage` or in total. */
  inFlight(stage?: LeaseStage): number;
  /** The largest reservation granted to `stage` so far this run (0 before the first). */
  maxReserved(stage: LeaseStage): number;
  /** Resolves on the next settle, or at once when nothing is in flight. */
  nextSettle(): Promise<void>;
  /**
   * Back-pressure (ADR-039): waits until the stage's expected worst case (`maxReserved`) fits,
   * settling in-flight calls to make room. False when it can't fit with nothing in flight.
   */
  waitForRoom(stage: LeaseStage): Promise<boolean>;
  settlement(): LeaseSettlement;
}

export interface RunLeaseOptions {
  grantedPence: number;
  /** S2 may use at most this share of the lease. */
  s2Share: number;
  /** False once the month is past the deep-pause line: every S3 reservation is refused. */
  deepAllowed: boolean;
}

const EPSILON = 1e-9;

function round(pence: number): number {
  return Math.round(pence * 10_000) / 10_000;
}

export function createRunLease(options: RunLeaseOptions): RunLease {
  const inFlight = new Map<string, { stage: LeaseStage; pence: number }>();
  const used: Record<LeaseStage, number> = { s2: 0, s3: 0 };
  const calls: Record<string, number> = {};
  const tokens: Record<string, TokenCounts> = {};
  const byPurpose: Record<string, number> = {};

  const inFlightPence = (stage?: LeaseStage) =>
    [...inFlight.values()]
      .filter((entry) => stage === undefined || entry.stage === stage)
      .reduce((sum, entry) => sum + entry.pence, 0);
  const usedTotal = () => used.s2 + used.s3;
  const maxReserved: Record<LeaseStage, number> = { s2: 0, s3: 0 };
  let settleWaiters: (() => void)[] = [];

  const fits = (stage: LeaseStage, pence: number) =>
    usedTotal() + inFlightPence() + pence <= options.grantedPence + EPSILON &&
    (stage !== 's2' ||
      used.s2 + inFlightPence('s2') + pence <= options.grantedPence * options.s2Share + EPSILON);

  function nextSettle(): Promise<void> {
    if (inFlight.size === 0) return Promise.resolve();
    return new Promise((resolve) => settleWaiters.push(resolve));
  }

  function usage(stage: LeaseStage): UsageStore {
    return {
      reserve(input) {
        if (stage === 's3' && !options.deepAllowed) {
          return Promise.reject(new RunBudgetExceededError('deep_pause'));
        }
        if (!fits(stage, input.pence)) {
          return Promise.reject(new RunBudgetExceededError('run_budget'));
        }
        inFlight.set(input.id, { stage, pence: input.pence });
        maxReserved[stage] = Math.max(maxReserved[stage], input.pence);
        return Promise.resolve();
      },
      settle(input) {
        inFlight.delete(input.id);
        used[stage] = round(used[stage] + input.costPence);
        calls[input.model] = (calls[input.model] ?? 0) + 1;
        const was = tokens[input.model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        tokens[input.model] = {
          input: was.input + input.tokens.input,
          output: was.output + input.tokens.output,
          cacheRead: was.cacheRead + input.tokens.cacheRead,
          cacheWrite: was.cacheWrite + input.tokens.cacheWrite,
        };
        byPurpose[input.purpose] = round((byPurpose[input.purpose] ?? 0) + input.costPence);
        const waiters = settleWaiters;
        settleWaiters = [];
        for (const wake of waiters) wake();
        return Promise.resolve();
      },
    };
  }

  return {
    grantedPence: options.grantedPence,
    usage,
    usedPence: (stage) => round(stage ? used[stage] : usedTotal()),
    inFlight: (stage) =>
      [...inFlight.values()].filter((entry) => stage === undefined || entry.stage === stage)
        .length,
    maxReserved: (stage) => maxReserved[stage],
    nextSettle,
    async waitForRoom(stage) {
      while (!fits(stage, maxReserved[stage])) {
        if (inFlight.size === 0) return false;
        await nextSettle();
      }
      return true;
    },
    settlement: () => ({
      costPence: round(usedTotal()),
      calls: { ...calls },
      tokens: structuredClone(tokens),
      byPurpose: { ...byPurpose },
    }),
  };
}
