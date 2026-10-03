// Must stay the first import: global options apply only to functions defined after it.
import '../options.js';

import { CALLABLE_TIMEOUT_SECONDS, type RescoreResult } from '@hireframe/shared';
import { onCall } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';

import { db } from '../admin.js';
import { requireOwner } from '../auth.js';
import { loadDevFakes, ownerOptions, useFakes } from '../callable.js';
import { ANTHROPIC_SECRET_NAME, SOURCE_SECRET_NAMES } from '../config.js';
import { safeHandler } from '../errors.js';
import { anthropicTransport } from '../llm/transport.js';
import { secretValue } from '../scan/handler.js';
import { firestoreScanStore } from '../scan/store.js';
import { rescoreHandler, runRescore } from './rescore.js';
import { funnelFor } from './wiring.js';

/**
 * rescore (PRD R3, ADR-037): the owner's "Re-score last 14 days" on the Criteria screen. Owner
 * only, App Check enforced and consumed (it can spend money); mounts the Anthropic key and the
 * Reed key (full text for jobs it sends to S3).
 */
const anthropicApiKey = defineSecret(ANTHROPIC_SECRET_NAME);
const reedApiKey = defineSecret(SOURCE_SECRET_NAMES.reedApiKey);

export const rescore = onCall(
  {
    ...ownerOptions,
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.rescore,
    secrets: [anthropicApiKey, reedApiKey],
  },
  safeHandler('rescore', async (request): Promise<RescoreResult> => {
    const config = await requireOwner(request);
    const firestore = db();
    const fakes = useFakes ? await loadDevFakes() : null;
    const reed = secretValue(reedApiKey.value());
    const funnel = funnelFor({
      firestore,
      config,
      transport: fakes ? fakes.fakeTransport() : anthropicTransport(anthropicApiKey.value()),
      fetch: fakes ? (fakes.fakeFetch as typeof fetch) : fetch,
      ...(fakes ? { reedApiKey: 'fake' } : reed ? { reedApiKey: reed } : {}),
    });
    return rescoreHandler(request.data, () =>
      runRescore({ store: firestoreScanStore(firestore), funnel, now: () => new Date() }),
    );
  }),
);
