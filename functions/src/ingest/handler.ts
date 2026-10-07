import {
  IngestRequestSchema,
  type IngestErrorCode,
  type IngestMessage,
  type IngestResponse,
} from '@hireframe/shared';

import { log } from '../log.js';
import { verifyRequest, type Compare, type SignedRequest } from './hmac.js';
import type { NonceStore } from './nonces.js';
import type { IngestResult } from './run.js';

/**
 * `ingestEmailJobs` request handling (ADR-046), kept apart from the function so it is testable
 * without Firebase: verify the signature on the raw body, then the nonce (only for a request that
 * verified), then the schema, then the pipeline. Errors carry a fixed code and no detail, and the
 * body is never echoed or logged.
 */
export interface IngestHandlerDeps {
  secret: string;
  nonces: NonceStore;
  now: () => Date;
  run: (messages: readonly IngestMessage[]) => Promise<IngestResult>;
  compare?: Compare;
}

export interface IngestHttpResult {
  status: 200 | 400 | 401 | 413 | 503;
  body: IngestResponse | { error: IngestErrorCode };
}

const error = (status: IngestHttpResult['status'], code: IngestErrorCode): IngestHttpResult => ({
  status,
  body: { error: code },
});

export async function ingestHandler(
  request: SignedRequest,
  deps: IngestHandlerDeps,
): Promise<IngestHttpResult> {
  const verified = verifyRequest(request, deps.secret, deps.now(), deps.compare);
  if (!verified.ok) {
    log.warn('ingest.refused', { reason: verified.failure });
    if (verified.status === 413) return error(413, 'too_large');
    if (verified.status === 400) return error(400, 'malformed');
    return error(401, 'unauthorized');
  }

  // Only a verified request spends a nonce, so unauthenticated traffic can't fill the store.
  if (!(await deps.nonces.claim(verified.nonce, deps.now()))) {
    log.warn('ingest.refused', { reason: 'replay' });
    return error(401, 'unauthorized');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(request.rawBody.toString('utf8'));
  } catch {
    log.warn('ingest.refused', { reason: 'json' });
    return error(400, 'malformed');
  }
  const body = IngestRequestSchema.safeParse(parsed);
  if (!body.success) {
    log.warn('ingest.refused', { reason: 'schema' });
    return error(400, 'malformed');
  }

  const result = await deps.run(body.data.messages);
  if (result.status === 'busy') return error(503, 'busy');
  return { status: 200, body: { results: result.results } };
}
