import { createHmac } from 'node:crypto';

import { INGEST_WIRE, signingString } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { runBridge, type BridgeMessage } from '../../../apps-script/src/bridge.js';
import { createSigner, type ComputeHmac } from '../../../apps-script/src/sign.js';
import { signRequest, verifyRequest, type SignedRequest } from './hmac.js';

/**
 * The Apps Script signer and the server's verifier agree (ADR-046). The script's HMAC primitive
 * returns signed bytes, so it is faked here with Node's HMAC mapped to -128..127.
 */
const SECRET = 'c0ffee11'.repeat(8);
const NONCE = '3b241101-e2bb-4255-8caf-4136c566a962';
const NOW = new Date('2026-10-07T09:00:00Z');

const appsScriptHmac =
  (secret: string): ComputeHmac =>
  (value, key) => {
    expect(key).toBe(secret.trim());
    return [...createHmac('sha256', key).update(value, 'utf8').digest()].map((b) =>
      b > 127 ? b - 256 : b,
    );
  };

function asRequest(body: string, headers: Record<string, string>): SignedRequest {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method: 'POST',
    contentType: 'application/json',
    rawBody: Buffer.from(body, 'utf8'),
    header: (name) => lower[name],
  };
}

describe('script signer ↔ server verifier', () => {
  it.each([
    ['ASCII', '{"messages":[]}'],
    ['multi-byte', JSON.stringify({ messages: [{ text: 'café — £35K 日本語 😀' }] })],
    ['empty-ish', '{}'],
  ])('a %s body signed by the script verifies on the server', (_name, body) => {
    const signer = createSigner(SECRET, appsScriptHmac(SECRET));
    const headers = signer.headers(body, Math.floor(NOW.getTime() / 1000), NONCE);
    expect(verifyRequest(asRequest(body, headers), SECRET, NOW)).toEqual({
      ok: true,
      nonce: NONCE,
    });
  });

  it('agrees on a fixed vector, signed negative bytes included', () => {
    const body = '{"a":1}';
    const timestamp = '1760000000';
    const signed = signingString(timestamp, NONCE, body);
    expect(signed).toBe(`v1.1760000000.${NONCE}.{"a":1}`);
    const bytes = createSigner(SECRET, appsScriptHmac(SECRET)).headers(body, 1_760_000_000, NONCE);
    expect(bytes['X-Hireframe-Signature']).toBe(signRequest(SECRET, timestamp, NONCE, body));
    expect(bytes['X-Hireframe-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('both sides trim the secret', () => {
    const body = '{"a":1}';
    const padded = ` ${SECRET}\n`;
    const signer = createSigner(padded, appsScriptHmac(SECRET));
    const headers = signer.headers(body, Math.floor(NOW.getTime() / 1000), NONCE);
    expect(verifyRequest(asRequest(body, headers), `${SECRET}\n`, NOW).ok).toBe(true);
  });
});

describe('the bridge’s own batches verify on the server', () => {
  const big = (id: string): BridgeMessage => ({
    id,
    receivedAt: '2026-10-07T08:00:00.000Z',
    from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
    text: 'é'.repeat(100_000),
    html: '日'.repeat(2_000_000), // 6 MB of html: capped, then truncated to fit, sent alone
  });

  it('a message over 2 MB is truncated, sent alone, and still verifies', () => {
    const posts: { body: string; headers: Record<string, string> }[] = [];
    runBridge({
      listPendingIds: () => ['m1'],
      getMessage: (id) => big(id),
      markDone: () => undefined,
      post: (body, headers) => {
        posts.push({ body, headers });
        return { status: 200, body: '{"results":[]}' };
      },
      signer: createSigner(SECRET, appsScriptHmac(SECRET)),
      uuid: () => NONCE,
      now: () => NOW.getTime(),
    });
    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(Buffer.byteLength(post?.body ?? '')).toBeLessThanOrEqual(INGEST_WIRE.maxPostBytes);
    expect(verifyRequest(asRequest(post?.body ?? '', post?.headers ?? {}), SECRET, NOW).ok).toBe(
      true,
    );
  });
});
