// Must stay the first import: global options apply only to functions defined after it.
import '../options.js';

import { CALLABLE_TIMEOUT_SECONDS } from '@hireframe/shared';
import { onCall } from 'firebase-functions/https';

import { bucket, db } from '../admin.js';
import { requireOwner } from '../auth.js';
import { ownerOptions } from '../callable.js';
import { safeHandler } from '../errors.js';
import { bucketFileDeleter, firestoreResetStore } from '../profile/store.js';
import { deleteAllDataHandler } from './run.js';
import { firestoreWipeStore } from './store.js';

/**
 * deleteAllData (ADR-057): owner only, App Check enforced and consumed (so the client never
 * retries it). One bounded pass per call; it never calls itself, and the client repeats it until
 * `done`. One instance and one request at a time: a second tab's call may be refused (the
 * dialog shows the error) rather than queued, which is safe. No secrets.
 */
export const deleteAllData = onCall(
  {
    ...ownerOptions,
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.deleteAllData,
    memory: '512MiB',
    // Stated here as well as in the global options, so a change there can't widen this one.
    maxInstances: 1,
    concurrency: 1,
  },
  safeHandler('deleteAllData', async (request) => {
    await requireOwner(request);
    const firestore = db();
    return deleteAllDataHandler(request.data, {
      store: firestoreWipeStore(firestore, bucket()),
      reset: {
        store: firestoreResetStore(firestore),
        deleteFiles: bucketFileDeleter(bucket()),
        now: () => new Date(),
      },
      now: () => new Date(),
    });
  }),
);
