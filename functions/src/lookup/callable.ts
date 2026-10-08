// Must stay the first import: global options apply only to functions defined after it.
import '../options.js';

import { randomUUID } from 'node:crypto';

import {
  CALLABLE_TIMEOUT_SECONDS,
  DEFAULT_MONTHLY_CAP_PENCE,
  type LookupResult,
} from '@hireframe/shared';
import { onCall } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';

import { db } from '../admin.js';
import { requireOwner } from '../auth.js';
import { loadDevFakes, ownerOptions, useFakes } from '../callable.js';
import {
  ANTHROPIC_SECRET_NAME,
  DEFAULT_FX_USD_TO_GBP,
  LOOKUP,
  LookupOverridesSchema,
} from '../config.js';
import { getCurrentCriteria } from '../criteria.js';
import { safeHandler } from '../errors.js';
import { firestoreFunnelStore } from '../funnel/store.js';
import { scanHttpClient } from '../http/scan-client.js';
import { anthropicTransport } from '../llm/transport.js';
import { dailyCapped, firestoreUsageStore } from '../llm/usage-store.js';
import { firestoreScanStore } from '../scan/store.js';
import { createAtsSearch } from './ats-search.js';
import { lookupHandler } from './handler.js';
import { firestoreLookupStore } from './store.js';

/**
 * lookup (PRD R8, ADR-049): the owner adds jobs found by hand, pastes a description, or has a
 * pasted results page read. Owner only, App Check enforced and consumed (it spends money, so the
 * client never retries it). Mounts the Anthropic key only; the job boards it reads are public.
 */
const anthropicApiKey = defineSecret(ANTHROPIC_SECRET_NAME);

export const lookup = onCall(
  {
    ...ownerOptions,
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.lookup,
    secrets: [anthropicApiKey],
  },
  safeHandler('lookup', async (request): Promise<LookupResult> => {
    const config = await requireOwner(request);
    const startedAtMs = Date.now();
    return lookupHandler(request.data, async () => {
      const firestore = db();
      const fakes = useFakes ? await loadDevFakes() : null;
      const fetchImpl = fakes ? (fakes.fakeFetch as typeof fetch) : fetch;
      const overrides = LookupOverridesSchema.safeParse(config.lookup ?? {});
      const dailyCapPence =
        (overrides.success ? overrides.data.dailyCapPence : undefined) ?? LOOKUP.dailyCapPence;
      const funnel = firestoreFunnelStore(firestore);
      return {
        scan: firestoreScanStore(firestore),
        store: firestoreLookupStore(firestore),
        funnel,
        readCriteria: () => getCurrentCriteria(firestore),
        llm: {
          transport: fakes ? fakes.fakeTransport() : anthropicTransport(anthropicApiKey.value()),
          usage: dailyCapped(firestoreUsageStore(firestore), 'lookup', dailyCapPence),
          capPence: config.monthlyCapPence ?? DEFAULT_MONTHLY_CAP_PENCE,
          fxUsdToGbp: config.fxUsdToGbp ?? DEFAULT_FX_USD_TO_GBP,
          // Reservation IDs start with the cap's key, so the day's live ones can be summed.
          newId: () => `lookup-${randomUUID()}`,
        },
        // Boards are fetched like a scan does (robots, User-Agent, spacing); LinkedIn never is.
        ats: createAtsSearch({
          http: scanHttpClient(fetchImpl, startedAtMs + LOOKUP.deadlineMs, []),
          watched: () => funnel.watchedCompanies(),
          maxBoards: LOOKUP.atsBoardsPerCall,
        }),
        now: () => new Date(),
        clock: Date.now,
        sleep: (ms) =>
          new Promise((resolve) => {
            setTimeout(resolve, ms);
          }),
        startedAtMs,
      };
    });
  }),
);
