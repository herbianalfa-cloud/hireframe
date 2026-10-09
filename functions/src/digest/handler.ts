import {
  DigestRequestSchema,
  dayKey,
  type DigestErrorCode,
  type DigestResponse,
} from '@hireframe/shared';

import { verifyRequest, type Compare, type SignedRequest } from '../ingest/hmac.js';
import type { NonceStore } from '../ingest/nonces.js';
import { log } from '../log.js';

/**
 * `getDigest` request handling (ADR-052), apart from the function so it is testable without
 * Firebase: verify the `digest.v1.` signature on the raw body, then the nonce (only for a request
 * that verified), then the schema, then the build. The error codes are ingest's: a uniform 401
 * for signature, skew, header and replay failures, 400 and 413 for the rest, no detail, and the
 * body is never echoed or logged.
 */
export interface DigestHandlerDeps {
  secret: string;
  nonces: NonceStore;
  now: () => Date;
  build: (
    request: { kind: 'morning' | 'fallback'; day: string },
    now: Date,
  ) => Promise<DigestResponse>;
  compare?: Compare;
}

export interface DigestHttpResult {
  status: 200 | 400 | 401 | 413;
  body: DigestResponse | { error: DigestErrorCode };
}

const error = (status: DigestHttpResult['status'], code: DigestErrorCode): DigestHttpResult => ({
  status,
  body: { error: code },
});

export async function digestHandler(
  request: SignedRequest,
  deps: DigestHandlerDeps,
): Promise<DigestHttpResult> {
  const verified = verifyRequest(request, deps.secret, deps.now(), deps.compare, 'digest');
  if (!verified.ok) {
    log.warn('digest.refused', { reason: verified.failure });
    if (verified.status === 413) return error(413, 'too_large');
    if (verified.status === 400) return error(400, 'malformed');
    return error(401, 'unauthorized');
  }

  // Only a verified request spends a nonce, so unauthenticated traffic can't fill the store.
  if (!(await deps.nonces.claim(verified.nonce, deps.now()))) {
    log.warn('digest.refused', { reason: 'replay' });
    return error(401, 'unauthorized');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(request.rawBody.toString('utf8'));
  } catch {
    log.warn('digest.refused', { reason: 'json' });
    return error(400, 'malformed');
  }
  const body = DigestRequestSchema.safeParse(parsed);
  if (!body.success) {
    log.warn('digest.refused', { reason: 'schema' });
    return error(400, 'malformed');
  }

  // The digest is for the server's London day: a day that isn't today is a stale or wrong request.
  const now = deps.now();
  if (body.data.day !== dayKey(now)) {
    log.warn('digest.refused', { reason: 'day' });
    return error(400, 'malformed');
  }

  const response = await deps.build(body.data, now);
  log.info('digest.done', { state: response.state, kind: body.data.kind });
  return { status: 200, body: response };
}
