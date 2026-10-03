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

  function usage(stage: LeaseStage): UsageStore {
    return {
      reserve(input) {
        if (stage === 's3' && !options.deepAllowed) {
          return Promise.reject(new RunBudgetExceededError('deep_pause'));
        }
        const total = usedTotal() + inFlightPence() + input.pence;
        const s2Fits =
          stage !== 's2' ||
          used.s2 + inFlightPence('s2') + input.pence <=
            options.grantedPence * options.s2Share + EPSILON;
        if (total > options.grantedPence + EPSILON || !s2Fits) {
          return Promise.reject(new RunBudgetExceededError('run_budget'));
        }
        inFlight.set(input.id, { stage, pence: input.pence });
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
        return Promise.resolve();
      },
    };
  }

  return {
    grantedPence: options.grantedPence,
    usage,
    usedPence: (stage) => round(stage ? used[stage] : usedTotal()),
    settlement: () => ({
      costPence: round(usedTotal()),
      calls: { ...calls },
      tokens: structuredClone(tokens),
      byPurpose: { ...byPurpose },
    }),
  };
}
