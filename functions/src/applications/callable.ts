// Must stay the first import: global options apply only to functions defined after it.
import '../options.js';

import { CALLABLE_TIMEOUT_SECONDS, DEFAULT_MONTHLY_CAP_PENCE } from '@hireframe/shared';
import { onCall } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';

import { bucket, db } from '../admin.js';
import { requireOwner } from '../auth.js';
import { loadDevFakes, ownerOptions, useFakes } from '../callable.js';
import {
  ANTHROPIC_SECRET_NAME,
  APPLICATIONS,
  ApplicationOverridesSchema,
  DEFAULT_FX_USD_TO_GBP,
} from '../config.js';
import { safeHandler } from '../errors.js';
import { llmCall, type LlmCallInput } from '../llm/call.js';
import { anthropicTransport } from '../llm/transport.js';
import { firestoreUsageStore } from '../llm/usage-store.js';
import { bucketFileDeleter, firestoreProfileStore } from '../profile/store.js';
import { applicationHandler } from './handler.js';
import { applicationLlmDeps } from './llm.js';
import { firestoreApplicationStore } from './store.js';

/**
 * application (M7, ADR-055): the owner's pipeline moves (start, answer, skip, retry, regenerate,
 * withdraw). It moves the stage and the worker does the writing; it never writes a CV. Owner
 * only, App Check enforced and consumed (an answer spends money, so the client never retries it).
 * Mounts the Anthropic key for `answerFact` only.
 */
const anthropicApiKey = defineSecret(ANTHROPIC_SECRET_NAME);

export const application = onCall(
  {
    ...ownerOptions,
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.application,
    // Stated here as well as in the global options, so a change there can't widen this one.
    maxInstances: 1,
    secrets: [anthropicApiKey],
  },
  safeHandler('application', async (request) => {
    const config = await requireOwner(request);
    const firestore = db();
    return applicationHandler(request.data, async () => {
      const overrides = ApplicationOverridesSchema.safeParse(config.applications ?? {});
      const dailyCapPence =
        (overrides.success ? overrides.data.dailyCapPence : undefined) ??
        APPLICATIONS.dailyCapPence;
      const deps = applicationLlmDeps({
        transport: useFakes
          ? (await loadDevFakes()).fakeTransport()
          : anthropicTransport(anthropicApiKey.value()),
        usage: firestoreUsageStore(firestore),
        dailyCapPence,
        capPence: config.monthlyCapPence ?? DEFAULT_MONTHLY_CAP_PENCE,
        fxUsdToGbp: config.fxUsdToGbp ?? DEFAULT_FX_USD_TO_GBP,
      });
      const profile = firestoreProfileStore(firestore);
      return {
        store: firestoreApplicationStore(firestore),
        facts: () => profile.listFacts(),
        llm: <T>(input: LlmCallInput<T>) => llmCall(deps, input),
        deleteFiles: bucketFileDeleter(bucket()),
        now: () => new Date(),
      };
    });
  }),
);
