import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  DIGEST_WIRE,
  INGEST_WIRE,
  signingPrefix,
  trimSecret,
  type SignaturePurpose,
} from '@hireframe/shared';

import { HMAC } from '../config.js';

/**
 * Verifies a signed `ingestEmailJobs` request (ADR-046, docs/SECURITY.md "Forged calls to
 * webhooks"), on the raw body bytes, never on re-serialised JSON. The signature is HMAC-SHA256
 * over `v1.<timestamp>.<nonce>.<raw body>` with the shared secret (trimmed, like the script's);
 * the digest uses `digest.v1.` instead, so a signature for one endpoint never verifies at the other.
 * Every signature, timestamp and header problem is the same 401 to the caller; the reason is a
 * fixed code for the log only. The nonce is checked afterwards, by the caller, and only for a
 * request that has already verified.
 */

export type VerifyFailure =
  'method' | 'content_type' | 'too_large' | 'headers' | 'signature' | 'skew';

export type VerifyResult =
  { ok: true; nonce: string } | { ok: false; status: 400 | 401 | 413; failure: VerifyFailure };

export interface SignedRequest {
  method: string;
  contentType: string | undefined;
  rawBody: Buffer;
  /** A request header by its lower-case name. */
  header: (name: string) => string | undefined;
}

const TIMESTAMP = /^\d{1,12}$/;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[0-9a-f]{64}$/i;

export type Compare = (a: Buffer, b: Buffer) => boolean;

/** The hex signature for `rawBody` (also what `scripts/sign-test-alert.ts` sends). */
export function signRequest(
  secret: string,
  timestamp: string,
  nonce: string,
  rawBody: Buffer | string,
  purpose: SignaturePurpose = 'ingest',
): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return createHmac('sha256', trimSecret(secret))
    .update(Buffer.concat([Buffer.from(signingPrefix(timestamp, nonce, purpose), 'utf8'), body]))
    .digest('hex');
}

function fail(status: 400 | 401 | 413, failure: VerifyFailure): VerifyResult {
  return { ok: false, status, failure };
}

export function verifyRequest(
  request: SignedRequest,
  secret: string,
  now: Date,
  compare: Compare = timingSafeEqual,
  purpose: SignaturePurpose = 'ingest',
): VerifyResult {
  if (request.method !== 'POST') return fail(400, 'method');
  if (!/^application\/json\b/i.test(request.contentType ?? '')) return fail(400, 'content_type');
  if (request.rawBody.length > (purpose === 'digest' ? DIGEST_WIRE : INGEST_WIRE).serverMaxBytes)
    return fail(413, 'too_large');

  const timestamp = request.header('x-hireframe-timestamp');
  const nonce = request.header('x-hireframe-nonce');
  const signature = request.header('x-hireframe-signature');
  if (
    timestamp === undefined ||
    nonce === undefined ||
    signature === undefined ||
    !TIMESTAMP.test(timestamp) ||
    !NONCE.test(nonce) ||
    !SIGNATURE.test(signature)
  ) {
    return fail(401, 'headers');
  }

  const given = Buffer.from(signature, 'hex');
  const expected = Buffer.from(
    signRequest(secret, timestamp, nonce, request.rawBody, purpose),
    'hex',
  );
  // Both are 32 bytes when the header was well-formed; a length mismatch takes the same 401.
  if (given.length !== expected.length || !compare(given, expected)) return fail(401, 'signature');

  if (Math.abs(now.getTime() - Number(timestamp) * 1000) > HMAC.maxSkewSeconds * 1000) {
    return fail(401, 'skew');
  }
  return { ok: true, nonce };
}
