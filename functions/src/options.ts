import { setGlobalOptions } from 'firebase-functions/options';

import { REGION, RUNTIME_SERVICE_ACCOUNT } from './config.js';

/**
 * Global function options (ADR-017): europe-west2, the dedicated `hireframe-fns` account, one
 * instance at most. Every module that defines functions imports this first: ES modules evaluate
 * their imports before their own body, so a call in index.ts would run too late.
 */
setGlobalOptions({ region: REGION, maxInstances: 1, serviceAccount: RUNTIME_SERVICE_ACCOUNT });
