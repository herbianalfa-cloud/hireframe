import { randomUUID } from 'node:crypto';

import type { DigestResponse } from '@hireframe/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLogSink } from '../log.js';
import { signRequest, type SignedRequest } from '../ingest/hmac.js';
import type { NonceStore } from '../ingest/nonces.js';
import { digestHandler, type DigestHandlerDeps } from './handler.js';

const SECRET = 'f00dfeed'.repeat(8);
// 2026-10-07 09:00Z is 10:00 in London (BST).
const NOW = new Date('2026-10-07T09:00:00Z');
const BODY = JSON.stringify({ kind: 'morning', day: '2026-10-07' });
const RESPONSE: DigestResponse = { state: 'ready', subject: 's', html: '<p>h</p>', text: 't' };

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  setLogSink((_level, event, fields) => logged.push(JSON.stringify({ event, ...fields })));
});
afterEach(() => {
  setLogSink();
});

function request(
  options: {
    body?: string;
    nonce?: string;
    offsetSeconds?: number;
    secret?: string;
    purpose?: 'digest' | 'ingest';
  } = {},
): SignedRequest {
  const body = options.body ?? BODY;
  const timestamp = String(Math.floor(NOW.getTime() / 1000) + (options.offsetSeconds ?? 0));
  const nonce = options.nonce ?? randomUUID();
  const headers: Record<string, string> = {
    'x-hireframe-timestamp': timestamp,
    'x-hireframe-nonce': nonce,
    'x-hireframe-signature': signRequest(
      options.secret ?? SECRET,
      timestamp,
      nonce,
      body,
      options.purpose ?? 'digest',
    ),
  };
  return {
    method: 'POST',
    contentType: 'application/json',
    rawBody: Buffer.from(body),
    header: (name) => headers[name],
  };
}

function setup() {
  const used = new Set<string>();
  const claim = vi.fn((nonce: string) => {
    if (used.has(nonce)) return Promise.resolve(false);
    used.add(nonce);
    return Promise.resolve(true);
  });
  const nonces: NonceStore = { claim };
  const build = vi.fn<DigestHandlerDeps['build']>(() => Promise.resolve(RESPONSE));
  const deps: DigestHandlerDeps = { secret: SECRET, nonces, now: () => NOW, build };
  return { claim, build, deps };
}

describe('digestHandler (ADR-052)', () => {
  it('builds and returns the digest for a valid signed request', async () => {
    const { deps, build } = setup();
    expect(await digestHandler(request(), deps)).toEqual({ status: 200, body: RESPONSE });
    expect(build).toHaveBeenCalledWith({ kind: 'morning', day: '2026-10-07' }, NOW);
  });

  it('refuses an ingest-signed request with the uniform 401, before the nonce or the build', async () => {
    const { deps, claim, build } = setup();
    expect(await digestHandler(request({ purpose: 'ingest' }), deps)).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    });
    expect(claim).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it.each([
    ['a wrong secret', { secret: 'b'.repeat(64) }],
    ['a stale timestamp', { offsetSeconds: -301 }],
    ['a future timestamp', { offsetSeconds: 301 }],
  ])('gives %s the same 401', async (_name, options) => {
    const { deps, build } = setup();
    expect(await digestHandler(request(options), deps)).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    });
    expect(build).not.toHaveBeenCalled();
  });

  it('accepts a timestamp at the 300 s edge', async () => {
    const { deps } = setup();
    expect((await digestHandler(request({ offsetSeconds: -300 }), deps)).status).toBe(200);
  });

  it('refuses a replay of the same nonce with the same 401, and builds once', async () => {
    const { deps, build } = setup();
    const nonce = randomUUID();
    expect((await digestHandler(request({ nonce }), deps)).status).toBe(200);
    expect(await digestHandler(request({ nonce }), deps)).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    });
    expect(build).toHaveBeenCalledTimes(1);
    expect(logged.join()).toContain('"reason":"replay"');
  });

  it('spends the nonce only for a verified request', async () => {
    const { deps, claim } = setup();
    await digestHandler(request({ secret: 'b'.repeat(64) }), deps);
    expect(claim).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', 'nope'],
    ['an unknown kind', JSON.stringify({ kind: 'evening', day: '2026-10-07' })],
    ['an extra key', JSON.stringify({ kind: 'morning', day: '2026-10-07', x: 1 })],
    ['a day that is not a date', JSON.stringify({ kind: 'morning', day: '2026-02-30' })],
    ['a day that is not today', JSON.stringify({ kind: 'morning', day: '2026-10-06' })],
  ])('answers 400 malformed for %s (signed correctly)', async (_name, body) => {
    const { deps, build } = setup();
    expect(await digestHandler(request({ body }), deps)).toEqual({
      status: 400,
      body: { error: 'malformed' },
    });
    expect(build).not.toHaveBeenCalled();
  });

  it('answers 413 for a body over the digest limit', async () => {
    const { deps } = setup();
    const body = JSON.stringify({ kind: 'morning', day: '2026-10-07', pad: 'x'.repeat(2_000) });
    expect(await digestHandler(request({ body }), deps)).toEqual({
      status: 413,
      body: { error: 'too_large' },
    });
  });

  it('answers 400 for another method', async () => {
    const { deps } = setup();
    expect((await digestHandler({ ...request(), method: 'GET' }, deps)).status).toBe(400);
  });

  it('logs codes only: never the body, the digest or the nonce', async () => {
    const { deps } = setup();
    const secretish = 'SECRET-BODY-MARKER';
    await digestHandler(
      request({ body: JSON.stringify({ kind: 'morning', day: secretish }) }),
      deps,
    );
    await digestHandler(request(), deps);
    const all = logged.join('\n');
    expect(all).not.toContain(secretish);
    expect(all).not.toContain(RESPONSE.html);
    expect(all).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(all).toContain('digest.done');
  });
});
