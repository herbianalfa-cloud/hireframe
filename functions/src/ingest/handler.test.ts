import { randomUUID } from 'node:crypto';

import type { IngestMessage } from '@hireframe/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLogSink } from '../log.js';
import { ingestHandler, type IngestHandlerDeps } from './handler.js';
import { signRequest, type SignedRequest } from './hmac.js';
import type { NonceStore } from './nonces.js';
import type { IngestResult } from './run.js';

const SECRET = 'f00dfeed'.repeat(8);
const NOW = new Date('2026-10-07T09:00:00Z');

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  setLogSink((_level, event, fields) => logged.push(JSON.stringify({ event, ...fields })));
});
afterEach(() => {
  setLogSink();
});

const message: IngestMessage = {
  id: 'm1',
  receivedAt: '2026-10-07T08:00:00.000Z',
  from: 'a <a@example.com>',
  text: 'secret email text',
  html: '',
};
const BODY = JSON.stringify({ messages: [message] });

function request(
  options: { body?: string; nonce?: string; offsetSeconds?: number; secret?: string } = {},
): SignedRequest {
  const body = options.body ?? BODY;
  const timestamp = String(Math.floor(NOW.getTime() / 1000) + (options.offsetSeconds ?? 0));
  const nonce = options.nonce ?? randomUUID();
  const headers: Record<string, string> = {
    'x-hireframe-timestamp': timestamp,
    'x-hireframe-nonce': nonce,
    'x-hireframe-signature': signRequest(options.secret ?? SECRET, timestamp, nonce, body),
  };
  return {
    method: 'POST',
    contentType: 'application/json',
    rawBody: Buffer.from(body),
    header: (name) => headers[name],
  };
}

function memoryNonces(): NonceStore & { used: Set<string> } {
  const used = new Set<string>();
  return {
    used,
    claim: (nonce) => {
      if (used.has(nonce)) return Promise.resolve(false);
      used.add(nonce);
      return Promise.resolve(true);
    },
  };
}

function setup(
  result: IngestResult = { status: 'done', results: [{ id: 'm1', status: 'processed' }] },
) {
  const nonces = memoryNonces();
  const run = vi.fn<IngestHandlerDeps['run']>(() => Promise.resolve(result));
  const deps: IngestHandlerDeps = { secret: SECRET, nonces, now: () => NOW, run };
  return { nonces, run, deps };
}

describe('ingestHandler (ADR-046)', () => {
  it('runs a verified request and returns the per-message statuses', async () => {
    const { deps, run } = setup();
    expect(await ingestHandler(request(), deps)).toEqual({
      status: 200,
      body: { results: [{ id: 'm1', status: 'processed' }] },
    });
    expect(run).toHaveBeenCalledWith([message]);
  });

  it('refuses a replay: the same signed request twice → the second is 401 and does nothing', async () => {
    const { deps, run } = setup();
    const signed = request({ nonce: '3b241101-e2bb-4255-8caf-4136c566a962' });
    expect((await ingestHandler(signed, deps)).status).toBe(200);
    expect(await ingestHandler(signed, deps)).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('accepts a fresh nonce on the same body', async () => {
    const { deps } = setup();
    expect((await ingestHandler(request(), deps)).status).toBe(200);
    expect((await ingestHandler(request(), deps)).status).toBe(200);
  });

  it('refuses an old timestamp with a new nonce, on skew', async () => {
    const { deps, run, nonces } = setup();
    const result = await ingestHandler(request({ offsetSeconds: -301 }), deps);
    expect(result).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(run).not.toHaveBeenCalled();
    expect(nonces.used.size).toBe(0);
  });

  it('writes a nonce only after the signature verified', async () => {
    const { deps, nonces } = setup();
    await ingestHandler(request({ secret: 'wrong' }), deps);
    await ingestHandler({ ...request(), rawBody: Buffer.from('{"tampered":true}') }, deps);
    expect(nonces.used.size).toBe(0);
    await ingestHandler(request(), deps);
    expect(nonces.used.size).toBe(1);
  });

  it.each([
    ['bad JSON', 'not json'],
    ['the wrong shape', JSON.stringify({ messages: 'x' })],
    ['an empty list', JSON.stringify({ messages: [] })],
    ['an unknown field', JSON.stringify({ messages: [{ ...message, subject: 'hi' }] })],
    ['a recipient field', JSON.stringify({ messages: [{ ...message, to: 'x@example.com' }] })],
    ['six messages', JSON.stringify({ messages: Array(6).fill(message) })],
    [
      'an oversize html part',
      JSON.stringify({ messages: [{ ...message, html: 'x'.repeat(300_001) }] }),
    ],
  ])('answers 400 for %s, after the signature', async (_name, body) => {
    const { deps, run } = setup();
    expect(await ingestHandler(request({ body }), deps)).toEqual({
      status: 400,
      body: { error: 'malformed' },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('answers 413 for a body over 1 MB', async () => {
    const { deps } = setup();
    const big = JSON.stringify({ messages: [{ ...message, text: 'x'.repeat(1_000_001) }] });
    expect(await ingestHandler(request({ body: big }), deps)).toEqual({
      status: 413,
      body: { error: 'too_large' },
    });
  });

  it('answers 503 busy when the lock is held', async () => {
    const { deps } = setup({ status: 'busy', holder: 'scan' });
    expect(await ingestHandler(request(), deps)).toEqual({ status: 503, body: { error: 'busy' } });
  });

  it('answers errors with a fixed code only and never echoes or logs the body', async () => {
    const { deps } = setup();
    const results = [
      await ingestHandler(request({ secret: 'wrong' }), deps),
      await ingestHandler(request({ body: 'secret email text but not json' }), deps),
      await ingestHandler(request({ offsetSeconds: 999 }), deps),
    ];
    for (const result of results) {
      expect(Object.keys(result.body)).toEqual(['error']);
      expect(JSON.stringify(result.body)).not.toContain('secret email text');
    }
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join('\n')).not.toContain('secret email text');
    expect(logged.join('\n')).not.toContain('example.com');
  });
});
