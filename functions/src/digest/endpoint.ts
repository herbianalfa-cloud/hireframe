// Must stay the first import: global options apply only to functions defined after it.
import '../options.js';

import { CALLABLE_TIMEOUT_SECONDS } from '@hireframe/shared';
import { onRequest } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';

import { db } from '../admin.js';
import { inEmulator } from '../callable.js';
import { INGEST_HMAC_SECRET_NAME, REGION } from '../config.js';
import { firestoreNonceStore } from '../ingest/nonces.js';
import { errorFields, log } from '../log.js';
import { secretValue } from '../scan/handler.js';
import { buildDigest } from './build.js';
import { digestHandler } from './handler.js';
import { firestoreDigestStore } from './store.js';

/**
 * getDigest (ADR-052): the morning digest's data and HTML for the Apps Script mailer. An HTTPS
 * function, publicly invocable like `ingestEmailJobs`: Apps Script can't present a Google identity
 * or an App Check token, so the HMAC (purpose `digest`, prefix `digest.v1.`) is the authentication.
 * It mounts only the shared HMAC secret, reads Firestore and makes no model call. One instance and
 * one request at a time.
 */
const hmacSecret = defineSecret(INGEST_HMAC_SECRET_NAME);

export const getDigest = onRequest(
  {
    region: REGION,
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.getDigest,
    memory: '512MiB',
    // Stated here, not only inherited from the global options.
    maxInstances: 1,
    concurrency: 1,
    cors: false,
    secrets: [hmacSecret],
  },
  async (request, response) => {
    try {
      // The emulator's placeholder is a usable local secret; a deployed function never has one.
      const secret = inEmulator ? hmacSecret.value() : secretValue(hmacSecret.value());
      if (!secret) {
        log.error('digest.failed', { step: 'secret_missing' });
        response.status(500).json({ error: 'internal' });
        return;
      }
      const result = await digestHandler(
        {
          method: request.method,
          contentType: request.header('content-type'),
          rawBody: request.rawBody,
          header: (name) => request.header(name),
        },
        {
          secret,
          // Firestore is first touched here, after the signature has verified (never before).
          nonces: { claim: (nonce, at) => firestoreNonceStore(db()).claim(nonce, at) },
          now: () => new Date(),
          build: (digestRequest, now) =>
            buildDigest(firestoreDigestStore(db()), digestRequest, now),
        },
      );
      response.status(result.status).json(result.body);
    } catch (error) {
      log.error('digest.failed', { step: 'handler', ...errorFields(error) });
      response.status(500).json({ error: 'internal' });
    }
  },
);
