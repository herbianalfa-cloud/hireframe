// Must stay the first import: global options apply only to functions defined after it.
import '../options.js';

import {
  AppConfigSchema,
  CALLABLE_TIMEOUT_SECONDS,
  DEFAULT_MONTHLY_CAP_PENCE,
  type AppConfig,
} from '@hireframe/shared';
import { onRequest } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';

import { db } from '../admin.js';
import { readAppConfigFromFirestore } from '../auth.js';
import { loadDevFakes, useFakes, inEmulator } from '../callable.js';
import {
  AlertOverridesSchema,
  ALERTS,
  ANTHROPIC_SECRET_NAME,
  DEFAULT_FX_USD_TO_GBP,
  INGEST_HMAC_SECRET_NAME,
  REGION,
} from '../config.js';
import { dailyCapped, firestoreUsageStore } from '../llm/usage-store.js';
import { anthropicTransport } from '../llm/transport.js';
import { errorFields, log } from '../log.js';
import { secretValue } from '../scan/handler.js';
import { ingestHandler } from './handler.js';
import { firestoreNonceStore } from './nonces.js';
import { createModelParser } from './parse-llm.js';
import { runIngest } from './run.js';
import { firestoreIngestStore } from './store.js';
import { randomUUID } from 'node:crypto';

/**
 * ingestEmailJobs (ADR-046): the Gmail bridge's webhook. An HTTPS function, not a callable: Apps
 * Script can't present a Google identity or an App Check token, so it is publicly invocable and
 * the HMAC on the raw body is the authentication (checked first, replays refused by nonce). One
 * instance at most, so ingests never run in parallel; the scan lock makes ingest and scans never
 * write at once (ADR-048). Mounts the HMAC secret and the Anthropic key (the model fallback).
 */
const hmacSecret = defineSecret(INGEST_HMAC_SECRET_NAME);
const anthropicApiKey = defineSecret(ANTHROPIC_SECRET_NAME);

async function readConfig(): Promise<
  Pick<AppConfig, 'monthlyCapPence' | 'fxUsdToGbp'> & {
    dailyCapPence: number;
  }
> {
  const raw = await readAppConfigFromFirestore();
  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) log.warn('ingest.refused', { reason: 'config_invalid' });
  const config = parsed.success ? parsed.data : undefined;
  const overrides = AlertOverridesSchema.safeParse(config?.alerts ?? {});
  return {
    ...(config?.monthlyCapPence === undefined ? {} : { monthlyCapPence: config.monthlyCapPence }),
    ...(config?.fxUsdToGbp === undefined ? {} : { fxUsdToGbp: config.fxUsdToGbp }),
    dailyCapPence:
      (overrides.success ? overrides.data.dailyCapPence : undefined) ?? ALERTS.dailyCapPence,
  };
}

export const ingestEmailJobs = onRequest(
  {
    region: REGION,
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.ingestEmailJobs,
    memory: '512MiB',
    // Stated here, not only inherited from the global options: ingests never run in parallel.
    maxInstances: 1,
    cors: false,
    secrets: [hmacSecret, anthropicApiKey],
  },
  async (request, response) => {
    try {
      // The emulator's placeholder is a usable local secret; a deployed function never has one.
      const secret = inEmulator ? hmacSecret.value() : secretValue(hmacSecret.value());
      if (!secret) {
        log.error('ingest.failed', { step: 'secret_missing' });
        response.status(500).json({ error: 'internal' });
        return;
      }
      const firestore = db();
      const result = await ingestHandler(
        {
          method: request.method,
          contentType: request.header('content-type'),
          rawBody: request.rawBody ?? Buffer.alloc(0),
          header: (name) => request.header(name),
        },
        {
          secret,
          nonces: firestoreNonceStore(firestore),
          now: () => new Date(),
          run: async (messages) => {
            const config = await readConfig();
            const fakes = useFakes ? await loadDevFakes() : null;
            const transport = fakes
              ? fakes.fakeTransport()
              : anthropicTransport(anthropicApiKey.value());
            const usage = dailyCapped(
              firestoreUsageStore(firestore),
              'alertParse',
              config.dailyCapPence,
            );
            return runIngest(
              {
                store: firestoreIngestStore(firestore),
                parseWithModel: createModelParser({
                  transport,
                  usage,
                  capPence: config.monthlyCapPence ?? DEFAULT_MONTHLY_CAP_PENCE,
                  fxUsdToGbp: config.fxUsdToGbp ?? DEFAULT_FX_USD_TO_GBP,
                  // Reservation IDs start with the purpose, so the day's live ones can be summed.
                  newId: () => `alertParse-${randomUUID()}`,
                }),
                now: () => new Date(),
                clock: Date.now,
              },
              messages,
            );
          },
        },
      );
      response.status(result.status).json(result.body);
    } catch (error) {
      log.error('ingest.failed', { step: 'handler', ...errorFields(error) });
      response.status(500).json({ error: 'internal' });
    }
  },
);
