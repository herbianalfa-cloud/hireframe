import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  basicAuth,
  createHttpClient,
  HttpError,
  type HostPolicy,
  type HttpClientDeps,
} from './client.js';

const Schema = z.object({ ok: z.boolean() });
const UA = 'HireframeBot/0.3 (+https://github.com/herbianalfa-cloud/hireframe)';

interface Call {
  url: string;
  at: number;
  headers: Record<string, string>;
}

type Reply = Response | Error | ((url: string) => Response | Error);

function harness(
  replies: Record<string, Reply[]>,
  overrides: Partial<HttpClientDeps> & { policy?: Partial<HostPolicy> } = {},
) {
  let clock = 1_000_000;
  const calls: Call[] = [];
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const fetchFake = (input: URL | string, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, at: clock, headers: { ...(init?.headers as Record<string, string>) } });
    const path = new URL(url).pathname;
    const queue = replies[path] ?? replies['*'] ?? [];
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    const value = typeof reply === 'function' ? reply(url) : reply;
    if (value === undefined) return Promise.resolve(new Response('', { status: 404 }));
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value.clone());
  };
  const { policy, ...rest } = overrides;
  const client = createHttpClient({
    fetch: fetchFake as typeof fetch,
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    random: () => 0,
    userAgent: UA,
    productToken: 'HireframeBot',
    hostPolicy: () => ({ robots: 'enforce', intervalMs: 1000, timeoutMs: 20_000, ...policy }),
    maxAttempts: 3,
    backoffBaseMs: 1000,
    retryAfterCapMs: 30_000,
    maxBodyBytes: 1000,
    log: (_level, event, fields) => logs.push({ event, fields }),
    ...rest,
  });
  return { client, calls, logs, advance: (ms: number) => (clock += ms) };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const NO_ROBOTS = [new Response('', { status: 404 })];
const opts = { label: 'test.endpoint' };

describe('http client', () => {
  it('sends the User-Agent and parses the response with zod', async () => {
    const { client, calls } = harness({ '/robots.txt': NO_ROBOTS, '/a': [json({ ok: true })] });
    await expect(client.getJson('https://api.example.com/a', Schema, opts)).resolves.toEqual({
      ok: true,
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/robots.txt', '/a']);
    expect(calls[1]?.headers['User-Agent']).toBe(UA);
    expect(client.requests()).toBe(1);
  });

  it('spaces requests to one host by its interval, and fetches robots.txt once', async () => {
    const { client, calls } = harness({ '/robots.txt': NO_ROBOTS, '*': [json({ ok: true })] });
    await Promise.all(
      ['/a', '/b', '/c'].map((path) =>
        client.getJson(`https://api.example.com${path}`, Schema, opts),
      ),
    );
    const starts = calls.map((call) => call.at);
    expect(calls.filter((call) => call.url.endsWith('/robots.txt'))).toHaveLength(1);
    for (let i = 1; i < starts.length; i++) {
      expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(1000);
    }
  });

  it('honours robots Crawl-delay when it is longer than the interval', async () => {
    const { client, calls } = harness({
      '/robots.txt': [new Response('User-agent: *\nCrawl-delay: 5')],
      '*': [json({ ok: true })],
    });
    await client.getJson('https://api.example.com/a', Schema, opts);
    await client.getJson('https://api.example.com/b', Schema, opts);
    expect((calls[2]?.at ?? 0) - (calls[1]?.at ?? 0)).toBeGreaterThanOrEqual(5000);
  });

  it('refuses paths robots.txt disallows, without requesting them', async () => {
    const { client, calls, logs } = harness({
      '/robots.txt': [new Response('User-agent: *\nDisallow: /private')],
    });
    await expect(
      client.getJson('https://api.example.com/private/x', Schema, opts),
    ).rejects.toMatchObject({ code: 'robots_disallowed' });
    expect(calls).toHaveLength(1);
    expect(logs.map((log) => log.event)).toEqual(['http.robots_blocked']);
  });

  it('treats an unreachable robots.txt as disallow-all', async () => {
    const { client } = harness({ '/robots.txt': [new Response('', { status: 503 })] });
    await expect(client.getJson('https://api.example.com/a', Schema, opts)).rejects.toMatchObject({
      code: 'robots_disallowed',
    });
  });

  it('skips robots.txt for keyed API hosts (ADR-025)', async () => {
    const { client, calls } = harness(
      { '/robots.txt': [new Response('User-agent: *\nDisallow: /')], '/api': [json({ ok: true })] },
      { policy: { robots: 'api-terms' } },
    );
    await expect(client.getJson('https://api.example.com/api', Schema, opts)).resolves.toEqual({
      ok: true,
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/api']);
  });

  it('retries 429 and 5xx with backoff, honouring Retry-After, and succeeds', async () => {
    const { client, calls, logs } = harness({
      '/robots.txt': NO_ROBOTS,
      '/a': [json({}, 429, { 'retry-after': '7' }), json({}, 503), json({ ok: true })],
    });
    await expect(client.getJson('https://api.example.com/a', Schema, opts)).resolves.toEqual({
      ok: true,
    });
    const starts = calls.slice(1).map((call) => call.at);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(7000);
    expect((starts[2] ?? 0) - (starts[1] ?? 0)).toBeGreaterThanOrEqual(2000);
    expect(logs.filter((log) => log.event === 'http.retry')).toHaveLength(2);
    expect(client.requests()).toBe(3);
  });

  it('gives up after 3 attempts', async () => {
    const { client, calls, logs } = harness({ '/robots.txt': NO_ROBOTS, '/a': [json({}, 500)] });
    await expect(client.getJson('https://api.example.com/a', Schema, opts)).rejects.toMatchObject({
      code: 'http_status',
      status: 500,
    });
    expect(calls).toHaveLength(4);
    expect(logs.at(-1)).toMatchObject({ event: 'http.failed', fields: { attempt: 3 } });
  });

  it('fails at once when Retry-After is beyond the cap', async () => {
    const { client, calls } = harness({
      '/robots.txt': NO_ROBOTS,
      '/a': [json({}, 429, { 'retry-after': '3600' })],
    });
    await expect(client.getJson('https://api.example.com/a', Schema, opts)).rejects.toMatchObject({
      code: 'rate_limited',
    });
    expect(calls).toHaveLength(2);
  });

  it('pauses a host after a Retry-After beyond the cap, logging it once', async () => {
    const { client, calls, logs } = harness({
      '/robots.txt': NO_ROBOTS,
      '/a': [json({}, 429, { 'retry-after': '3600' })],
      '*': [json({ ok: true })],
    });
    await expect(client.getJson('https://api.example.com/a', Schema, opts)).rejects.toMatchObject({
      code: 'rate_limited',
    });
    for (const path of ['/b', '/c']) {
      await expect(
        client.getJson(`https://api.example.com${path}`, Schema, opts),
      ).rejects.toMatchObject({ code: 'host_paused' });
    }
    // No request reached the paused host after the 429; another host is unaffected.
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/robots.txt', '/a']);
    await expect(client.getJson('https://other.example.com/x', Schema, opts)).resolves.toEqual({
      ok: true,
    });
    const paused = logs.filter((log) => log.event === 'http.host_paused');
    expect(paused).toHaveLength(1);
    expect(paused[0]?.fields).toMatchObject({ host: 'api.example.com', seconds: 3600 });
    expect(client.pauses()).toEqual([
      { host: 'api.example.com', until: expect.any(Number) as number },
    ]);
  });

  it('honours pauses carried over from an earlier run until they end', async () => {
    const h = harness(
      { '/robots.txt': NO_ROBOTS, '*': [json({ ok: true })] },
      { paused: [{ host: 'api.example.com', until: 1_005_000 }] },
    );
    await expect(h.client.getJson('https://api.example.com/a', Schema, opts)).rejects.toMatchObject(
      {
        code: 'host_paused',
      },
    );
    expect(h.calls).toHaveLength(0);
    expect(h.logs.filter((log) => log.event === 'http.host_paused')).toHaveLength(1);
    h.advance(6_000);
    await expect(h.client.getJson('https://api.example.com/a', Schema, opts)).resolves.toEqual({
      ok: true,
    });
    expect(h.client.pauses()).toEqual([]);
  });

  it('retries timeouts and network errors', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const { client } = harness({
      '/robots.txt': NO_ROBOTS,
      '/a': [timeout, new TypeError('fetch failed'), json({ ok: true })],
    });
    await expect(client.getJson('https://api.example.com/a', Schema, opts)).resolves.toEqual({
      ok: true,
    });
  });

  it('never retries a 404 or a schema error', async () => {
    const { client, calls } = harness({
      '/robots.txt': NO_ROBOTS,
      '/missing': [new Response('', { status: 404 })],
      '/bad': [json({ ok: 'yes' })],
    });
    await expect(
      client.getJson('https://api.example.com/missing', Schema, opts),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(client.getJson('https://api.example.com/bad', Schema, opts)).rejects.toMatchObject(
      { code: 'schema', issues: 1 },
    );
    expect(calls).toHaveLength(3);
  });

  it('rejects invalid JSON and oversized bodies', async () => {
    const { client } = harness({
      '/robots.txt': NO_ROBOTS,
      '/html': [new Response('<html>')],
      '/big': [new Response('x'.repeat(2000))],
    });
    await expect(
      client.getJson('https://api.example.com/html', Schema, opts),
    ).rejects.toMatchObject({ code: 'invalid_json' });
    await expect(client.getJson('https://api.example.com/big', Schema, opts)).rejects.toMatchObject(
      { code: 'too_large' },
    );
  });

  it('starts no request after the deadline', async () => {
    const h = harness(
      { '/robots.txt': NO_ROBOTS, '*': [json({ ok: true })] },
      { deadline: 1_002_500 },
    );
    await h.client.getJson('https://api.example.com/a', Schema, opts);
    h.advance(2000);
    const error: unknown = await h.client
      .getJson('https://api.example.com/b', Schema, opts)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ code: 'deadline' });
    expect(h.calls).toHaveLength(2);
  });

  it('never logs a URL or a query-string key', async () => {
    const { client, logs } = harness({ '/robots.txt': NO_ROBOTS, '/a': [json({}, 500)] });
    await client
      .getJson('https://api.example.com/a?app_key=SECRET123', Schema, opts)
      .catch(() => undefined);
    const text = JSON.stringify(logs);
    expect(text).not.toContain('SECRET123');
    expect(text).not.toContain('https://');
    expect(logs[0]?.fields).toMatchObject({ host: 'api.example.com', label: 'test.endpoint' });
  });

  it('builds a Basic auth header with an empty password', () => {
    expect(basicAuth('key')).toBe(`Basic ${Buffer.from('key:').toString('base64')}`);
  });
});
