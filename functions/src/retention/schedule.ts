// Must stay the first import: global options apply only to functions defined after it.
import '../options.js';

import { CALLABLE_TIMEOUT_SECONDS } from '@hireframe/shared';
import { onSchedule } from 'firebase-functions/scheduler';

import { db } from '../admin.js';
import { REGION, RETENTION_SCHEDULE } from '../config.js';
import { errorFields, log } from '../log.js';
import { runRetention } from './run.js';
import { firestoreRetentionStore } from './store.js';

/**
 * purgeOldData (ADR-057): deletes the stored description of skipped jobs older than 60 days.
 * Started only by its schedule (03:30 every day, UK time); there is no Firestore or Storage
 * trigger and nothing re-enqueues it. One instance, no platform retry (the next day's run
 * continues from the saved cursor), no secrets.
 */
export const purgeOldData = onSchedule(
  {
    schedule: RETENTION_SCHEDULE.cron,
    timeZone: RETENTION_SCHEDULE.timeZone,
    region: REGION,
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.purgeOldData,
    memory: '512MiB',
    maxInstances: 1,
    retryCount: 0,
  },
  async () => {
    try {
      await runRetention({ store: firestoreRetentionStore(db()), now: () => new Date() });
    } catch (error) {
      log.error('retention.failed', { step: 'run', ...errorFields(error) });
    }
  },
);
