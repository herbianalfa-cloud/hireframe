// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- gas.d.ts is a global script file; an import would not load its types
/// <reference path="../../../apps-script/src/gas.d.ts" />
import { createHmac } from 'node:crypto';

import { INGEST_WIRE, signingString, toSignedBytes, utf8Bytes } from '@hireframe/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runBridge, type BridgeMessage } from '../../../apps-script/src/bridge.js';
import { run as runScript } from '../../../apps-script/src/main.js';
import { createSigner, type ComputeHmac } from '../../../apps-script/src/sign.js';
import { signRequest, verifyRequest, type SignedRequest } from './hmac.js';

/**
 * The Apps Script signer and the server's verifier agree (ADR-046). The script's HMAC primitive
 * returns signed bytes, so it is faked here with Node's HMAC mapped to -128..127.
 */
const SECRET = 'c0ffee11'.repeat(8);
const NONCE = '3b241101-e2bb-4255-8caf-4136c566a962';
const NOW = new Date('2026-10-07T09:00:00Z');

/** Apps Script's byte-array HMAC: signed bytes in, signed bytes out; a string is a TypeError. */
function computeHmacSigned(value: number[], key: number[]): number[] {
  if (!Array.isArray(value) || !Array.isArray(key)) throw new TypeError('bytes only');
  const unsigned = (bytes: number[]) => Buffer.from(bytes.map((b) => b & 0xff));
  return [...createHmac('sha256', unsigned(key)).update(unsigned(value)).digest()].map((b) =>
    b > 127 ? b - 256 : b,
  );
}

/** The script's wrapper, as main.ts builds it: unsigned in, the runtime's signed bytes out. */
const appsScriptHmac =
  (secret: string): ComputeHmac =>
  (value, key) => {
    expect(Buffer.from(key).toString('utf8')).toBe(secret.trim());
    return computeHmacSigned(toSignedBytes(value), toSignedBytes(key));
  };

function asRequest(
  body: string | readonly number[],
  headers: Record<string, string>,
): SignedRequest {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method: 'POST',
    contentType: 'application/json',
    rawBody: typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body),
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
    const headers = signer.headers(utf8Bytes(body), Math.floor(NOW.getTime() / 1000), NONCE);
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
    const bytes = createSigner(SECRET, appsScriptHmac(SECRET)).headers(
      utf8Bytes(body),
      1_760_000_000,
      NONCE,
    );
    expect(bytes['X-Hireframe-Signature']).toBe(signRequest(SECRET, timestamp, NONCE, body));
    expect(bytes['X-Hireframe-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('both sides trim the secret', () => {
    const body = '{"a":1}';
    const padded = ` ${SECRET}\n`;
    const signer = createSigner(padded, appsScriptHmac(SECRET));
    const headers = signer.headers(utf8Bytes(body), Math.floor(NOW.getTime() / 1000), NONCE);
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
    const posts: { body: readonly number[]; headers: Record<string, string> }[] = [];
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
    expect(post?.body.length).toBeLessThanOrEqual(INGEST_WIRE.maxPostBytes);
    expect(verifyRequest(asRequest(post?.body ?? [], post?.headers ?? {}), SECRET, NOW).ok).toBe(
      true,
    );
  });
});

describe('the Apps Script glue, with non-ASCII text (· and £)', () => {
  const TEXT = 'Product Analyst · Acme Analytics · London · £45K - £55K';
  const SECRET_PROPERTY = ` ${SECRET}\n`;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A fake runtime that, like the real one, takes only signed byte arrays for HMAC and payload. */
  function runtime(posted: { options: Record<string, unknown> }[]) {
    const properties: Record<string, string> = {
      HIREFRAME_INGEST_URL: 'https://example.invalid/ingestEmailJobs',
      HIREFRAME_HMAC_SECRET: SECRET_PROPERTY,
    };
    const plain = Buffer.from(TEXT, 'utf8').toString('base64url');
    vi.stubGlobal('PropertiesService', {
      getScriptProperties: () => ({ getProperty: (name: string) => properties[name] ?? null }),
    });
    vi.stubGlobal('Logger', { log: () => undefined });
    vi.stubGlobal('Gmail', {
      Users: {
        Labels: {
          list: () => ({
            labels: [
              { id: 'L1', name: 'hireframe/alerts' },
              { id: 'L2', name: 'hireframe/done' },
            ],
          }),
        },
        Messages: {
          list: () => ({ messages: [{ id: 'm1' }] }),
          get: () => ({
            id: 'm1',
            internalDate: String(NOW.getTime()),
            payload: {
              headers: [{ name: 'From', value: 'Alerts <jobalerts-noreply@linkedin.com>' }],
              parts: [
                { mimeType: 'text/plain', body: { data: plain } },
                { mimeType: 'text/html', body: { data: plain } },
              ],
            },
          }),
          modify: () => undefined,
        },
      },
    });
    vi.stubGlobal('Utilities', {
      getUuid: () => NONCE,
      base64DecodeWebSafe: (data: string) => toSignedBytes([...Buffer.from(data, 'base64url')]),
      newBlob: (bytes: number[]) => ({
        getDataAsString: () => Buffer.from(bytes.map((b) => b & 0xff)).toString('utf8'),
      }),
      computeHmacSha256Signature: computeHmacSigned,
    });
    vi.stubGlobal('UrlFetchApp', {
      fetch: (_url: string, options: Record<string, unknown>) => {
        posted.push({ options });
        return {
          getResponseCode: () => 200,
          getContentText: () => '{"results":[{"id":"m1","status":"processed"}]}',
        };
      },
    });
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  }

  it('signs the bytes it sends, as UTF-8 JSON, and the server verifies and reads them', () => {
    const posted: { options: Record<string, unknown> }[] = [];
    runtime(posted);
    try {
      runScript();
    } finally {
      vi.useRealTimers();
    }
    expect(posted).toHaveLength(1);
    const { options } = posted[0] ?? { options: {} };
    expect(options.contentType).toBe('application/json; charset=utf-8');
    const payload = options.payload as number[];
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.every((b) => b >= -128 && b <= 127)).toBe(true);
    const rawBody = Buffer.from(payload.map((b) => b & 0xff));
    expect(rawBody.toString('utf8')).toContain('·');
    expect(rawBody.toString('utf8')).toContain('£');
    expect(JSON.parse(rawBody.toString('utf8'))).toMatchObject({ messages: [{ text: TEXT }] });

    const headers = options.headers as Record<string, string>;
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(
      verifyRequest(
        {
          method: 'POST',
          contentType: options.contentType as string,
          rawBody,
          header: (name) => lower[name],
        },
        SECRET,
        NOW,
      ),
    ).toEqual({ ok: true, nonce: NONCE });
    // The same signature, from the Node reference implementation.
    expect(headers['X-Hireframe-Signature']).toBe(
      signRequest(SECRET, headers['X-Hireframe-Timestamp'] ?? '', NONCE, rawBody),
    );
  });

  it('agrees on a fixed vector with · and £', () => {
    const body = JSON.stringify({ messages: [{ text: '· £' }] });
    const headers = createSigner(SECRET, appsScriptHmac(SECRET)).headers(
      utf8Bytes(body),
      1_760_000_000,
      NONCE,
    );
    expect(headers['X-Hireframe-Signature']).toBe(
      signRequest(SECRET, '1760000000', NONCE, Buffer.from(body, 'utf8')),
    );
    // Signing the Latin-1 or UTF-16 reading of the same text would give a different signature.
    expect(headers['X-Hireframe-Signature']).not.toBe(
      signRequest(SECRET, '1760000000', NONCE, Buffer.from(body, 'latin1')),
    );
  });
});
