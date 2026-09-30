/**
 * Cloud Functions entry point (docs/ARCHITECTURE.md "Functions", ADR-017). Every function runs
 * in europe-west2 as the dedicated `hireframe-fns` account, with one instance at most.
 */
import { setGlobalOptions } from 'firebase-functions/options';

import { REGION, RUNTIME_SERVICE_ACCOUNT } from './config.js';

setGlobalOptions({ region: REGION, maxInstances: 1, serviceAccount: RUNTIME_SERVICE_ACCOUNT });

export { addFact, parseCv } from './profile/callables.js';
