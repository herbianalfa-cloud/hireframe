// Must stay the first import: global options apply only to functions defined after it.
import '../options.js';

import {
  AppConfigSchema,
  CALLABLE_TIMEOUT_SECONDS,
  WATCHLIST_SEED,
  type AppConfig,
  type ScanNowResult,
} from '@hireframe/shared';
import { onCall } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';
import { onSchedule } from 'firebase-functions/scheduler';

import { db } from '../admin.js';
import { readAppConfigFromFirestore, requireOwner } from '../auth.js';
import { loadDevFakes, ownerOptions, useFakes } from '../callable.js';
import {
  ANTHROPIC_SECRET_NAME,
  CALLABLE,
  REGION,
  SCAN,
  SCHEDULE,
  SOURCE_SECRET_NAMES,
} from '../config.js';
import { getCurrentCriteria } from '../criteria.js';
import { safeHandler } from '../errors.js';
import { funnelFor } from '../funnel/wiring.js';
import { scanHttpClient } from '../http/scan-client.js';
import { anthropicTransport } from '../llm/transport.js';
import { errorFields, log } from '../log.js';
import { createSources } from '../sources/index.js';
import { scanNowHandler, secretValue } from './handler.js';
import { runScan, type ScanDeps } from './run.js';
import { firestoreScanStore } from './store.js';

/**
 * scanNow (the owner's "Scan now") and scheduledScan (07:30 and 17:30 on weekdays, Europe/London)
 * (ADR-029, ADR-037): sources → normalise → dedupe → jobs at `s0` → the funnel (S1–S3). They share
 * the single-flight lock, mount the job API keys and the Anthropic key, and use the fake fetch,
 * watchlist and model in the emulator unless LIVE=1.
 */
const anthropicApiKey = defineSecret(ANTHROPIC_SECRET_NAME);
const reedApiKey = defineSecret(SOURCE_SECRET_NAMES.reedApiKey);
const adzunaAppId = defineSecret(SOURCE_SECRET_NAMES.adzunaAppId);
const adzunaAppKey = defineSecret(SOURCE_SECRET_NAMES.adzunaAppKey);
const scanSecrets = [anthropicApiKey, reedApiKey, adzunaAppId, adzunaAppKey];

async function scanDeps(config: AppConfig, trigger: 'manual' | 'schedule'): Promise<ScanDeps> {
  const firestore = db();
  const fakes = useFakes ? await loadDevFakes() : null;
  const fetchImpl = fakes ? (fakes.fakeFetch as typeof fetch) : fetch;
  const reed = secretValue(reedApiKey.value());
  const adzunaId = secretValue(adzunaAppId.value());
  const adzunaKey = secretValue(adzunaAppKey.value());
  return {
    store: firestoreScanStore(firestore),
    readCriteria: () => getCurrentCriteria(firestore),
    createSources,
    httpFor: (deadline, paused) => scanHttpClient(fetchImpl, deadline, paused),
    // The fake job APIs need no keys, so Reed and Adzuna run on their fixtures locally.
    secrets: fakes
      ? { reedApiKey: 'fake', adzunaAppId: 'fake', adzunaAppKey: 'fake' }
      : {
          ...(reed ? { reedApiKey: reed } : {}),
          ...(adzunaId ? { adzunaAppId: adzunaId } : {}),
          ...(adzunaKey ? { adzunaAppKey: adzunaKey } : {}),
        },
    seed: fakes ? fakes.FAKE_SEED : WATCHLIST_SEED,
    disabledSources: config.disabledSources ?? [],
    // A scheduled run always runs unless a scan holds the lock.
    cooldownMs: trigger === 'schedule' ? 0 : useFakes ? SCAN.emulatorCooldownMs : SCAN.cooldownMs,
    trigger,
    now: () => new Date(),
    funnel: funnelFor({
      firestore,
      config,
      transport: fakes ? fakes.fakeTransport() : anthropicTransport(anthropicApiKey.value()),
      fetch: fetchImpl,
      ...(fakes ? { reedApiKey: 'fake' } : reed ? { reedApiKey: reed } : {}),
    }),
  };
}

export const scanNow = onCall(
  { ...ownerOptions, timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.scanNow, secrets: scanSecrets },
  safeHandler('scanNow', async (request): Promise<ScanNowResult> => {
    const config = await requireOwner(request);
    const deps = await scanDeps(config, 'manual');
    return scanNowHandler(request.data, () => runScan(deps));
  }),
);

export const scheduledScan = onSchedule(
  {
    schedule: SCHEDULE.cron,
    timeZone: SCHEDULE.timeZone,
    region: REGION,
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.scanNow,
    memory: CALLABLE.memory,
    retryCount: 0,
    secrets: scanSecrets,
  },
  async () => {
    const parsed = AppConfigSchema.safeParse(await readAppConfigFromFirestore());
    if (!parsed.success) {
      log.error('scan.failed', { step: 'config', trigger: 'schedule' });
      return;
    }
    try {
      const result = await runScan(await scanDeps(parsed.data, 'schedule'));
      if (result.status !== 'completed') log.info('scan.refused', { trigger: 'schedule' });
    } catch (error) {
      // runScan has already marked the run failed; nothing to retry (retryCount 0).
      log.error('scan.failed', { trigger: 'schedule', ...errorFields(error) });
    }
  },
);
