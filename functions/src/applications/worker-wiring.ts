import { DEFAULT_MONTHLY_CAP_PENCE, type AppConfig } from '@hireframe/shared';
import type { Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';

import { APPLICATIONS, ApplicationOverridesSchema, DEFAULT_FX_USD_TO_GBP } from '../config.js';
import { llmCall, type LlmCallInput } from '../llm/call.js';
import type { LlmTransport } from '../llm/transport.js';
import { firestoreUsageStore } from '../llm/usage-store.js';
import { firestoreProfileStore } from '../profile/store.js';
import { bucketCvFiles } from './files.js';
import { applicationLlmDeps } from './llm.js';
import { firestoreApplicationStore } from './store.js';
import type { CvWorkerDeps } from './worker.js';

/**
 * The worker's real dependencies. Kept apart from `schedule.ts` (which registers the function) so
 * `scripts/dev-worker.ts` can run one pass against the emulator without importing the function
 * definition. The renderer is loaded on first use: `import()` keeps pdf-lib and docx out of every
 * other function's cold start (the build splits it into its own chunk).
 */
export function cvWorkerDeps(input: {
  firestore: Firestore;
  bucket: ReturnType<Storage['bucket']>;
  transport: LlmTransport;
  config: AppConfig;
  now?: () => Date;
}): CvWorkerDeps {
  const { firestore, config } = input;
  const overrides = ApplicationOverridesSchema.safeParse(config.applications ?? {});
  const llm = applicationLlmDeps({
    transport: input.transport,
    usage: firestoreUsageStore(firestore),
    dailyCapPence:
      (overrides.success ? overrides.data.dailyCapPence : undefined) ?? APPLICATIONS.dailyCapPence,
    capPence: config.monthlyCapPence ?? DEFAULT_MONTHLY_CAP_PENCE,
    fxUsdToGbp: config.fxUsdToGbp ?? DEFAULT_FX_USD_TO_GBP,
  });
  const profile = firestoreProfileStore(firestore);
  return {
    store: firestoreApplicationStore(firestore),
    facts: () => profile.listFacts(),
    llm: <T>(call: LlmCallInput<T>) => llmCall(llm, call),
    files: bucketCvFiles(input.bucket),
    loadRenderer: () => import('../cv/render/index.js'),
    now: input.now ?? (() => new Date()),
    limits: {
      maxPerRun: APPLICATIONS.workerMaxPerRun,
      readLimit: APPLICATIONS.workerReadLimit,
      startDeadlineMs: APPLICATIONS.workerStartDeadlineMs,
      maxAttempts: APPLICATIONS.maxAttempts,
    },
  };
}
