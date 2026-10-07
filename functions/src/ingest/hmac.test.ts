import { createHmac, timingSafeEqual } from 'node:crypto';

import { INGEST_WIRE, signingString } from '@hireframe/shared';
import { describe, expect, it, vi } from 'vitest';

import { HMAC } from '../config.js';
import { signRequest, verifyRequest, type SignedRequest } from './hmac.js';

const SECRET = 'a3f1c0de'.repeat(8);
const NONCE = '3b241101-e2bb-4255-8caf-4136c566a962';
const NOW = new Date('2026-10-07T09:00:00Z');
const BODY = JSON.stringify({ messages: [{ id: 'm1', note: 'café' }] });

function signed(
  overrides: {
    secret?: string;
    body?: string;
    timestamp?: string;
    nonce?: string;
    signature?: string;
    method?: string;
    contentType?: string;
    sentBody?: Buffer;
  } = {},
): SignedRequest {
  const timestamp = overrides.timestamp ?? String(Math.floor(NOW.getTime() / 1000));
  const nonce = overrides.nonce ?? NONCE;
  const body = overrides.body ?? BODY;
  const signature =
    overrides.signature ?? signRequest(overrides.secret ?? SECRET, timestamp, nonce, body);
  const headers: Record<string, string | undefined> = {
    'x-hireframe-timestamp': timestamp,
    'x-hireframe-nonce': nonce,
    'x-hireframe-signature': signature,
  };
  return {
    method: overrides.method ?? 'POST',
    contentType: overrides.contentType ?? 'application/json; charset=utf-8',
    rawBody: overrides.sentBody ?? Buffer.from(body, 'utf8'),
    header: (name) => headers[name],
  };
}

const verify = (request: SignedRequest, now = NOW, secret = SECRET) =>
  verifyRequest(request, secret, now);

describe('verifyRequest (ADR-046)', () => {
  it('accepts a valid signed request and returns its nonce', () => {
    expect(verify(signed())).toEqual({ ok: true, nonce: NONCE });
  });

  it.each([
    ['a different secret', signed({ secret: 'b'.repeat(64) })],
    ['a changed body byte', signed({ sentBody: Buffer.from(BODY.replace('m1', 'm2')) })],
    [
      'a changed timestamp',
      {
        ...signed(),
        header: (n: string) =>
          n === 'x-hireframe-timestamp'
            ? String(Math.floor(NOW.getTime() / 1000) + 1)
            : signed().header(n),
      },
    ],
    [
      'a swapped nonce',
      {
        ...signed(),
        header: (n: string) =>
          n === 'x-hireframe-nonce' ? '11111111-2222-4333-8444-555555555555' : signed().header(n),
      },
    ],
  ])('rejects %s with 401', (_name, request) => {
    expect(verify(request)).toMatchObject({ ok: false, status: 401 });
  });

  it('signs v1.<timestamp>.<nonce>.<raw body> with the trimmed secret', () => {
    const timestamp = String(Math.floor(NOW.getTime() / 1000));
    expect(signRequest(SECRET, timestamp, NONCE, BODY)).toBe(
      createHmac('sha256', SECRET)
        .update(signingString(timestamp, NONCE, BODY))
        .digest('hex'),
    );
  });

  describe('timestamp skew', () => {
    const at = (offsetSeconds: number) => {
      const timestamp = String(Math.floor(NOW.getTime() / 1000) + offsetSeconds);
      return signed({ timestamp });
    };
    it('accepts up to 300 s either way and refuses 301 s', () => {
      expect(HMAC.maxSkewSeconds).toBe(300);
      expect(verify(at(-299)).ok).toBe(true);
      expect(verify(at(299)).ok).toBe(true);
      expect(verify(at(-300)).ok).toBe(true);
      expect(verify(at(-301))).toMatchObject({ ok: false, status: 401, failure: 'skew' });
      expect(verify(at(301))).toMatchObject({ ok: false, status: 401, failure: 'skew' });
    });
  });

  describe('signature headers', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['not hex', 'z'.repeat(64)],
      ['too short', 'ab'.repeat(31)],
      ['too long', 'ab'.repeat(33)],
      ['with a prefix', `sha256=${'ab'.repeat(32)}`],
    ])('a %s signature is a 401, without throwing', (_name, signature) => {
      const request = signed();
      const withSignature: SignedRequest = {
        ...request,
        header: (name) => (name === 'x-hireframe-signature' ? signature : request.header(name)),
      };
      expect(verify(withSignature)).toMatchObject({ ok: false, status: 401 });
    });

    it.each(['x-hireframe-timestamp', 'x-hireframe-nonce'])('a missing %s is a 401', (missing) => {
      const request = signed();
      expect(
        verify({
          ...request,
          header: (name) => (name === missing ? undefined : request.header(name)),
        }),
      ).toMatchObject({ ok: false, status: 401 });
    });

    it('refuses a nonce that is not a UUID v4, and a non-numeric timestamp', () => {
      expect(verify(signed({ nonce: 'not-a-uuid' }))).toMatchObject({ ok: false, status: 401 });
      expect(verify(signed({ timestamp: '12abc' }))).toMatchObject({ ok: false, status: 401 });
    });
  });

  it('compares through timingSafeEqual, and a length mismatch never reaches it', () => {
    const compare = vi.fn(timingSafeEqual);
    expect(verifyRequest(signed(), SECRET, NOW, compare).ok).toBe(true);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0]?.map((buffer) => buffer.byteLength)).toEqual([32, 32]);

    compare.mockClear();
    const short = signed({ signature: 'ab'.repeat(31) });
    expect(verifyRequest(short, SECRET, NOW, compare)).toMatchObject({ ok: false, status: 401 });
    expect(compare).not.toHaveBeenCalled();
  });

  it('rejects other methods, other content types and oversize bodies before the signature', () => {
    expect(verify(signed({ method: 'GET' }))).toMatchObject({ ok: false, status: 400 });
    expect(verify(signed({ contentType: 'text/plain' }))).toMatchObject({ ok: false, status: 400 });
    const big = 'x'.repeat(INGEST_WIRE.serverMaxBytes + 1);
    expect(verify(signed({ body: big }))).toMatchObject({ ok: false, status: 413 });
  });

  describe('secret whitespace', () => {
    it.each(['\n', '  ', ' \n'])('a secret stored with %j around it still verifies', (pad) => {
      // Signed by one side with the clean secret, verified by the other holding a padded copy.
      expect(verify(signed(), NOW, `${pad}${SECRET}${pad}`).ok).toBe(true);
      expect(verify(signed({ secret: `${pad}${SECRET}${pad}` })).ok).toBe(true);
    });

    it('still fails for an otherwise different secret', () => {
      expect(verify(signed(), NOW, `${SECRET}x\n`)).toMatchObject({ ok: false, status: 401 });
    });
  });
});
