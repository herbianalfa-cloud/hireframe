import type { AppConfig } from '@hireframe/shared';
import type { Firestore } from 'firebase-admin/firestore';

import {
  DEFAULT_FX_USD_TO_GBP,
  DEFAULT_MONTHLY_CAP_PENCE,
  FUNNEL,
  funnelLimits,
  FunnelOverridesSchema,
  type FunnelOverrides,
} from '../config.js';
import { getCurrentCriteria } from '../criteria.js';
import { scanHttpClient } from '../http/scan-client.js';
import type { LlmTransport } from '../llm/transport.js';
import { firestoreUsageStore } from '../llm/usage-store.js';
import { log } from '../log.js';
import { createReedHydrator } from './hydrate.js';
import { runFunnel, type FunnelOutcome } from './run.js';
import { firestoreFunnelStore } from './store.js';

/**
 * Builds the funnel for `scanNow`, `scheduledScan` and `rescore` from the app config and the
 * mounted secrets. Reads the current criteria at the start of each run, so a criteria change is
 * used by the next run (PRD R3).
 */
export interface FunnelWiring {
  firestore: Firestore;
  config: AppConfig;
  transport: LlmTransport;
  /** Fetch for Reed hydration (the fake one in the emulator). */
  fetch: typeof fetch;
  reedApiKey?: string;
}

export type FunnelRunner = (input: {
  runId: string;
  startedAt: Date;
  rescoreSince?: Date;
}) => Promise<FunnelOutcome>;

/** `config/app.funnel`, or nothing when it's missing or invalid (logged, never fatal). */
export function funnelOverrides(config: Pick<AppConfig, 'funnel'>): FunnelOverrides {
  if (config.funnel === undefined) return {};
  const parsed = FunnelOverridesSchema.safeParse(config.funnel);
  if (parsed.success) return parsed.data;
  log.warn('funnel.overrides_invalid', { issues: parsed.error.issues.length });
  return {};
}

export function funnelFor(wiring: FunnelWiring): FunnelRunner {
  const monthlyCapPence = wiring.config.monthlyCapPence ?? DEFAULT_MONTHLY_CAP_PENCE;
  const limits = funnelLimits(monthlyCapPence, funnelOverrides(wiring.config));
  return async ({ runId, startedAt, rescoreSince }) => {
    const store = firestoreFunnelStore(wiring.firestore);
    const criteria = await getCurrentCriteria(wiring.firestore);
    const reedApiKey = wiring.reedApiKey;
    const hydrator = reedApiKey
      ? createReedHydrator({
          http: scanHttpClient(
            wiring.fetch,
            startedAt.getTime() + FUNNEL.s3StopMs,
            await store.reedPauses(),
          ),
          apiKey: reedApiKey,
          perRun: limits.reedHydratePerRun,
          readQuota: () => store.reedQuota(),
          saveQuota: (quota) => store.saveReedQuota(quota),
          saveFullText: (jobId, text, now) => store.saveFullText(jobId, text, now),
          now: () => new Date(),
        })
      : null;
    log.info('funnel.started', { runId, rescore: rescoreSince !== undefined });
    const outcome = await runFunnel(
      {
        store,
        leases: firestoreUsageStore(wiring.firestore),
        transport: wiring.transport,
        fxUsdToGbp: wiring.config.fxUsdToGbp ?? DEFAULT_FX_USD_TO_GBP,
        monthlyCapPence,
        limits,
        criteria,
        hydrator,
        now: () => new Date(),
        clock: Date.now,
        sleep: (ms) =>
          new Promise((resolve) => {
            setTimeout(resolve, ms);
          }),
        startedAtMs: startedAt.getTime(),
      },
      { runId, ...(rescoreSince ? { rescoreSince } : {}) },
    );
    log.info('funnel.done', {
      runId,
      s1: outcome.perStage.s1.in,
      s2: outcome.perStage.s2.in,
      s3: outcome.perStage.s3.in,
      costPence: outcome.costPence,
      stoppedBy: outcome.budget.stoppedBy ?? 'none',
    });
    return outcome;
  };
}
