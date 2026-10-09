import { EventEmitter } from 'node:events';

import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signRequest } from '../ingest/hmac.js';
import { setLogSink } from '../log.js';

/**
 * The wiring in endpoint.ts (ADR-052): a missing secret is a plain 500, and nothing touches
 * Firestore before the signature has verified. The mock throws if used, so a regression fails
 * loudly rather than reading a fake.
 */
const mocks = vi.hoisted(() => ({
  db: vi.fn((): never => {
    throw new Error('Firestore touched');
  }),
}));

vi.mock('../admin.js', () => ({ db: mocks.db, bucket: vi.fn() }));

const { getDigest } = await import('./endpoint.js');

const SECRET = 'f00dfeed'.repeat(8);
const NONCE = '3b241101-e2bb-4255-8caf-4136c566a962';
const BODY = JSON.stringify({ kind: 'morning', day: '2026-10-07' });

interface Sent {
  status?: number;
  body?: unknown;
}

async function call(options: {
  method?: string;
  contentType?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<Sent> {
  const sent: Sent = {};
  const headers = options.headers ?? {};
  const request = {
    method: options.method ?? 'POST',
    headers: {},
    rawBody: Buffer.from(options.body ?? BODY, 'utf8'),
    header: (name: string) =>
      name.toLowerCase() === 'content-type'
        ? (options.contentType ?? 'application/json')
        : headers[name.toLowerCase()],
  } as unknown as Request;
  // `cors: false` puts the handler behind the framework's cors wrapper, which wants a real-ish
  // response: an emitter with header methods, finishing when the body is sent.
  const emitter = new EventEmitter();
  const response = Object.assign(emitter, {
    setHeader: () => response,
    getHeader: () => undefined,
    status(code: number) {
      sent.status = code;
      return response;
    },
    json(body: unknown) {
      sent.body = body;
      emitter.emit('finish');
      return response;
    },
  }) as unknown as Response;
  await (getDigest as unknown as (req: Request, res: Response) => Promise<void>)(request, response);
  return sent;
}

function signed(
  secret: string,
  purpose: 'digest' | 'ingest' = 'digest',
  body = BODY,
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'x-hireframe-timestamp': timestamp,
    'x-hireframe-nonce': NONCE,
    'x-hireframe-signature': signRequest(secret, timestamp, NONCE, body, purpose),
  };
}

let logged: { event: string; fields: Record<string, unknown> }[] = [];
beforeEach(() => {
  logged = [];
  setLogSink((_level, event, fields) => logged.push({ event, fields }));
  process.env.INGEST_HMAC_SECRET = SECRET;
  vi.clearAllMocks();
});
afterEach(() => {
  setLogSink();
  delete process.env.INGEST_HMAC_SECRET;
});

describe('getDigest wiring', () => {
  it('answers 500 internal when the secret is not mounted, and touches nothing', async () => {
    delete process.env.INGEST_HMAC_SECRET;
    expect(await call({ headers: signed(SECRET) })).toEqual({
      status: 500,
      body: { error: 'internal' },
    });
    expect(logged).toContainEqual({
      event: 'digest.failed',
      fields: expect.objectContaining({ step: 'secret_missing' }) as Record<string, unknown>,
    });
    expect(mocks.db).not.toHaveBeenCalled();
  });

  it.each([
    ['a wrong signature', { headers: signed('another-secret') }, 401],
    ['an ingest-signed request', { headers: signed(SECRET, 'ingest') }, 401],
    ['no signature headers', { headers: {} }, 401],
    ['a body changed after signing', { headers: signed(SECRET), body: '{"kind":"fallback"}' }, 401],
    ['the wrong method', { method: 'GET', headers: signed(SECRET) }, 400],
    ['the wrong content type', { contentType: 'text/plain', headers: signed(SECRET) }, 400],
  ])('%s: refused before Firestore is touched', async (_name, options, status) => {
    const sent = await call(options);
    expect(sent.status).toBe(status);
    expect(mocks.db).not.toHaveBeenCalled();
  });

  it('reaches Firestore only once the signature has verified (and a failure there is a 500)', async () => {
    const sent = await call({ headers: signed(SECRET) });
    // The nonce claim is the first Firestore access; the mock throws, so the handler answers 500.
    expect(mocks.db).toHaveBeenCalledTimes(1);
    expect(sent).toEqual({ status: 500, body: { error: 'internal' } });
  });
});
