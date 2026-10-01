// Must stay the first import: global options apply only to functions defined after it.
import '../options.js';

import {
  CALLABLE_TIMEOUT_SECONDS,
  ScanNowInputSchema,
  WATCHLIST_SEED,
  type ScanNowResult,
} from '@hireframe/shared';
import { HttpsError, onCall } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';

import { db } from '../admin.js';
import { requireOwner } from '../auth.js';
import { ownerOptions, useFakes } from '../callable.js';
import { hostPolicy, SCAN, SOURCE_SECRET_NAMES } from '../config.js';
import { getCurrentCriteria } from '../criteria.js';
import { safeHandler } from '../errors.js';
import { createHttpClient } from '../http/client.js';
import { log } from '../log.js';
import { fakeFetch } from '../sources/fake-fetch.js';
import { FAKE_SEED } from '../sources/fixtures.js';
import { createSources } from '../sources/index.js';
import { runScan } from './run.js';
import { firestoreScanStore } from './store.js';

/**
 * scanNow (ADR-029): the owner's "Scan now". Ingest-only in M3: sources → normalise → dedupe →
 * jobs at stage `s0`. M4 adds the funnel after it. Mounts only the job API keys. The emulator
 * uses the fake fetch and the fake watchlist unless LIVE=1.
 */
const reedApiKey = defineSecret(SOURCE_SECRET_NAMES.reedApiKey);
const adzunaAppId = defineSecret(SOURCE_SECRET_NAMES.adzunaAppId);
const adzunaAppKey = defineSecret(SOURCE_SECRET_NAMES.adzunaAppKey);

/** Placeholder values (local dev) count as no key. */
function secretValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' || trimmed === 'emulator-placeholder' ? undefined : trimmed;
}

export const scanNow = onCall(
  {
    ...ownerOptions,
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.scanNow,
    secrets: [reedApiKey, adzunaAppId, adzunaAppKey],
  },
  safeHandler('scanNow', async (request): Promise<ScanNowResult> => {
    const config = await requireOwner(request);
    if (!ScanNowInputSchema.safeParse(request.data ?? {}).success) {
      throw new HttpsError('invalid-argument', 'Unexpected input.');
    }
    const firestore = db();
    const reed = secretValue(reedApiKey.value());
    const adzunaId = secretValue(adzunaAppId.value());
    const adzunaKey = secretValue(adzunaAppKey.value());
    const result = await runScan({
      store: firestoreScanStore(firestore),
      readCriteria: () => getCurrentCriteria(firestore),
      createSources,
      httpFor: (deadline) =>
        createHttpClient({
          fetch: useFakes ? (fakeFetch as typeof fetch) : fetch,
          now: Date.now,
          sleep: (ms) =>
            new Promise((resolve) => {
              setTimeout(resolve, ms);
            }),
          random: Math.random,
          userAgent: SCAN.userAgent,
          productToken: SCAN.productToken,
          hostPolicy,
          maxAttempts: SCAN.maxAttempts,
          backoffBaseMs: SCAN.backoffBaseMs,
          retryAfterCapMs: SCAN.retryAfterCapMs,
          maxBodyBytes: SCAN.maxBodyBytes,
          deadline,
          log: (level, event, fields) => {
            log[level](event, fields);
          },
        }),
      secrets: {
        ...(reed ? { reedApiKey: reed } : {}),
        ...(adzunaId ? { adzunaAppId: adzunaId } : {}),
        ...(adzunaKey ? { adzunaAppKey: adzunaKey } : {}),
      },
      seed: useFakes ? FAKE_SEED : WATCHLIST_SEED,
      disabledSources: config.disabledSources ?? [],
      cooldownMs: useFakes ? SCAN.emulatorCooldownMs : SCAN.cooldownMs,
      trigger: 'manual',
      now: () => new Date(),
    });
    if (result.status === 'busy') {
      throw new HttpsError('failed-precondition', 'A scan is already running.');
    }
    return result;
  }),
);
