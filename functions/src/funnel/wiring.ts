import { DEFAULT_MONTHLY_CAP_PENCE, type AppConfig } from '@hireframe/shared';
import type { Firestore } from 'firebase-admin/firestore';

import {
  DEFAULT_FX_USD_TO_GBP,
  FUNNEL,
  funnelLimits,
  FunnelOverridesSchema,
  type FunnelOverrides,
} from '../config.js';
import { getCurrentCriteria } from '../criteria.js';
import type { HttpClient } from '../http/client.js';
import { scanHttpClient } from '../http/scan-client.js';
import type { LlmTransport } from '../llm/transport.js';
import { firestoreUsageStore } from '../llm/usage-store.js';
import { log } from '../log.js';
import { createAtsSearch } from '../lookup/ats-search.js';
import { composeHydrators, createAtsHydrator, createReedHydrator } from './hydrate.js';
import { runFunnel, type FunnelOutcome, type Hydrator } from './run.js';
import { firestoreFunnelStore, type FirestoreFunnelStore } from './store.js';

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
  /** When the function was invoked: the funnel's deadlines count from here. */
  invokedAt: Date;
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

/**
 * The scan's ATS hydrator: its own HTTP client (the forbidden hosts, the run's deadline and the
 * pauses earlier runs were given), saving the pauses it is given when the run ends.
 */
export interface AtsHydratorDeps {
  fetch: typeof fetch;
  store: Pick<
    FirestoreFunnelStore,
    'watchedCompanies' | 'attachPosting' | 'atsPauses' | 'saveAtsPauses'
  >;
  /** Epoch ms after which no board request starts (the S3 stop, from the invocation). */
  deadline: number;
}

/** The client behind the ATS hydrator: scan rules, the deadline and the carried pauses. */
export async function atsHttpClient(deps: AtsHydratorDeps): Promise<HttpClient> {
  return scanHttpClient(deps.fetch, deps.deadline, await deps.store.atsPauses(new Date()));
}

export async function atsHydratorFor(deps: AtsHydratorDeps): Promise<Hydrator> {
  const http = await atsHttpClient(deps);
  return createAtsHydrator({
    search: createAtsSearch({
      http,
      watched: () => deps.store.watchedCompanies(),
      maxBoards: FUNNEL.atsBoardsPerRun,
    }),
    attach: (entry, match, now) => deps.store.attachPosting(entry, match.posting, now),
    now: () => new Date(),
    savePauses: () => deps.store.saveAtsPauses(http.pauses(), new Date()),
  });
}

export function funnelFor(wiring: FunnelWiring): FunnelRunner {
  const monthlyCapPence = wiring.config.monthlyCapPence ?? DEFAULT_MONTHLY_CAP_PENCE;
  const limits = funnelLimits(monthlyCapPence, funnelOverrides(wiring.config));
  return async ({ runId, invokedAt, rescoreSince }) => {
    const store = firestoreFunnelStore(wiring.firestore);
    const criteria = await getCurrentCriteria(wiring.firestore);
    const reedApiKey = wiring.reedApiKey;
    const reed = reedApiKey
      ? createReedHydrator({
          http: scanHttpClient(
            wiring.fetch,
            invokedAt.getTime() + FUNNEL.s3StopMs,
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
    // A separate client: Reed's request count is its quota (ADR-029), the boards' is not.
    const ats = await atsHydratorFor({
      fetch: wiring.fetch,
      store,
      deadline: invokedAt.getTime() + FUNNEL.s3StopMs,
    });
    const hydrator = composeHydrators(reed ? [reed, ats] : [ats]);
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
        startedAtMs: invokedAt.getTime(),
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
