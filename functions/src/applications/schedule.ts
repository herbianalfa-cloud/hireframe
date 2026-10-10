// Must stay the first import: global options apply only to functions defined after it.
import '../options.js';

import { AppConfigSchema, CALLABLE_TIMEOUT_SECONDS } from '@hireframe/shared';
import { defineSecret } from 'firebase-functions/params';
import { onSchedule } from 'firebase-functions/scheduler';

import { bucket, db } from '../admin.js';
import { readAppConfigFromFirestore } from '../auth.js';
import { loadDevFakes, useFakes } from '../callable.js';
import { ANTHROPIC_SECRET_NAME, CALLABLE, CV_WORKER_SCHEDULE, REGION } from '../config.js';
import { anthropicTransport } from '../llm/transport.js';
import { errorFields, log } from '../log.js';
import { runCvWorker } from './worker.js';
import { cvWorkerDeps } from './worker-wiring.js';

/**
 * generateCvs (M7 7D.2, ADR-053): the CV worker. Started only by its schedule (every 10 minutes,
 * 07:00 to 23:50, UK time); there is no Firestore or Storage trigger and nothing re-enqueues it.
 * One instance, no platform retry (a failed run is simply followed by the next scheduled one),
 * and the model key is its only secret. Each run takes at most `APPLICATIONS.workerMaxPerRun`
 * applications and starts no model call after `APPLICATIONS.workerStartDeadlineMs`.
 */
const anthropicApiKey = defineSecret(ANTHROPIC_SECRET_NAME);

export const generateCvs = onSchedule(
  {
    schedule: CV_WORKER_SCHEDULE.cron,
    timeZone: CV_WORKER_SCHEDULE.timeZone,
    region: REGION,
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.generateCvs,
    memory: CALLABLE.memory,
    maxInstances: 1,
    retryCount: 0,
    secrets: [anthropicApiKey],
  },
  async () => {
    const config = AppConfigSchema.safeParse(await readAppConfigFromFirestore());
    if (!config.success) {
      log.error('cv_worker.failed', { step: 'config' });
      return;
    }
    try {
      const transport = useFakes
        ? (await loadDevFakes()).fakeTransport()
        : anthropicTransport(anthropicApiKey.value());
      await runCvWorker(
        cvWorkerDeps({ firestore: db(), bucket: bucket(), transport, config: config.data }),
      );
    } catch (error) {
      // Nothing to retry (retryCount 0): the next scheduled run picks the jobs up.
      log.error('cv_worker.failed', { step: 'run', ...errorFields(error) });
    }
  },
);
