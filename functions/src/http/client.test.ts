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
  method: string | undefined;
  body: string | undefined;
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
    calls.push({
      url,
      at: clock,
      headers: { ...(init?.headers as Record<string, string>) },
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
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

  it('logs host and path only: no query string, key, Authorization header or token (Adzuna-style URL)', async () => {
    const adzuna =
      'https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=ID123&app_key=KEY456&what=nurse';
    const headers = { Authorization: 'Bearer TOKEN789' };
    const secrets = ['app_id', 'app_key', 'ID123', 'KEY456', 'TOKEN789', 'Bearer', 'what=', '?'];
    const leaks = (value: unknown) => secrets.filter((s) => JSON.stringify(value).includes(s));
    const o = { label: 'adzuna.search', headers };
    const robots = { '/robots.txt': NO_ROBOTS };
    const path = '/v1/api/jobs/gb/search/1';

    const cases: Record<string, Parameters<typeof harness>[0]> = {
      success: { ...robots, [path]: [json({ ok: true })] },
      retry: { ...robots, [path]: [json({}, 503), json({ ok: true })] },
      http_status: { ...robots, [path]: [json({}, 403)] },
      network: {
        ...robots,
        [path]: [new Error(`connect failed for ${adzuna} ${headers.Authorization}`)],
      },
      timeout: { ...robots, [path]: [Object.assign(new Error(adzuna), { name: 'TimeoutError' })] },
      schema: { ...robots, [path]: [json({ nope: 1 })] },
    };
    for (const [name, replies] of Object.entries(cases)) {
      const h = harness(replies);
      const outcome = await h.client.getJson(adzuna, Schema, o).catch((e: unknown) => e);
      expect(leaks(h.logs), name).toEqual([]);
      if (outcome instanceof Error) expect(leaks(outcome.message), name).toEqual([]);
      if (name !== 'success') {
        expect(h.logs.at(-1)?.fields, name).toMatchObject({
          host: 'api.adzuna.com',
          path,
          label: 'adzuna.search',
        });
      }
    }

    const blocked = harness({
      '/robots.txt': [new Response('User-agent: *\nDisallow: /v1/', { status: 200 })],
    });
    await blocked.client.getJson(adzuna, Schema, o).catch(() => undefined);
    expect(blocked.logs[0]?.event).toBe('http.robots_blocked');
    expect(leaks(blocked.logs)).toEqual([]);

    const forbidden = harness({}, { forbiddenHosts: ['adzuna.com'] });
    await forbidden.client.getJson(adzuna, Schema, o).catch(() => undefined);
    expect(forbidden.logs[0]?.event).toBe('http.forbidden_host');
    expect(leaks(forbidden.logs)).toEqual([]);
  });

  it('refuses a forbidden host and its subdomains before any fetch, robots.txt included', async () => {
    const h = harness({ '*': [json({ ok: true })] }, { forbiddenHosts: ['linkedin.com'] });
    for (const url of [
      'https://www.linkedin.com/jobs/view/4012345678',
      'https://LinkedIn.com/jobs/view/1',
      'https://uk.linkedin.com/comm/jobs/view/1',
      'https://www.linkedin.com./jobs/view/1',
    ]) {
      await expect(h.client.getJson(url, Schema, opts)).rejects.toMatchObject({
        code: 'forbidden_host',
      });
    }
    expect(h.calls).toHaveLength(0);
    expect(h.client.requests()).toBe(0);
    expect(h.logs[0]).toMatchObject({ event: 'http.forbidden_host' });
    // A host that merely contains the name is not the host.
    await expect(
      harness(
        { '/robots.txt': NO_ROBOTS, '/a': [json({ ok: true })] },
        {
          forbiddenHosts: ['linkedin.com'],
        },
      ).client.getJson('https://notlinkedin.com/a', Schema, opts),
    ).resolves.toEqual({ ok: true });
  });

  it('refuses LinkedIn with no options at all: the forbidden list is the default', async () => {
    const h = harness({ '*': [json({ ok: true })] });
    for (const url of [
      'https://www.linkedin.com/jobs/view/4012345678',
      'https://lnkd.in/abc',
      'https://angel.co/jobs',
      'https://www.indeed.ie/viewjob',
      'https://www.glassdoor.ca/job',
    ]) {
      await expect(h.client.getJson(url, Schema, opts)).rejects.toMatchObject({
        code: 'forbidden_host',
      });
    }
    expect(h.calls).toHaveLength(0);
  });

  it('checks every redirect hop: a board that redirects to LinkedIn is never followed there', async () => {
    const redirect = (to: string, status = 302) =>
      new Response('', { status, headers: { Location: to } });
    const h = harness({
      '/robots.txt': NO_ROBOTS,
      '/start': [redirect('https://boards.example.com/hop')],
      '/hop': [redirect('https://uk.linkedin.com/jobs/view/1')],
      '/dot': [redirect('https://www.linkedin.com./jobs/view/1')],
    });
    await expect(
      h.client.getJson('https://boards.example.com/start', Schema, opts),
    ).rejects.toMatchObject({ code: 'forbidden_host' });
    expect(h.calls.map((call) => new URL(call.url).host)).not.toContain('uk.linkedin.com');
    expect(h.logs.some((entry) => entry.event === 'http.forbidden_host')).toBe(true);
    // The fully qualified form (trailing dot) is the same host.
    await expect(
      h.client.getJson('https://boards.example.com/dot', Schema, opts),
    ).rejects.toMatchObject({ code: 'forbidden_host' });
    expect(h.calls.map((call) => new URL(call.url).host)).not.toContain('www.linkedin.com.');
  });

  it('follows up to 3 redirect hops by hand and no more', async () => {
    const redirect = (to: string) => new Response('', { status: 301, headers: { Location: to } });
    const ok = harness({
      '/robots.txt': NO_ROBOTS,
      '/a': [redirect('/b')],
      '/b': [redirect('/c')],
      '/c': [redirect('/d')],
      '/d': [json({ ok: true })],
    });
    await expect(ok.client.getJson('https://api.example.com/a', Schema, opts)).resolves.toEqual({
      ok: true,
    });
    const tooMany = harness({
      '/robots.txt': NO_ROBOTS,
      '/a': [redirect('/b')],
      '/b': [redirect('/c')],
      '/c': [redirect('/d')],
      '/d': [redirect('/e')],
      '/e': [json({ ok: true })],
    });
    await expect(
      tooMany.client.getJson('https://api.example.com/a', Schema, opts),
    ).rejects.toMatchObject({ code: 'http_status' });
    expect(tooMany.calls.map((call) => new URL(call.url).pathname)).not.toContain('/e');
  });

  it('builds a Basic auth header with an empty password', () => {
    expect(basicAuth('key')).toBe(`Basic ${Buffer.from('key:').toString('base64')}`);
  });
});

describe('http client: PUT and plain http (ADR-059)', () => {
  const keyed = { policy: { robots: 'api-terms' as const } };

  it('PUTs a JSON body once and parses the answer', async () => {
    const { client, calls } = harness({ '/b': [json({ ok: true })] }, keyed);
    await expect(
      client.putJson('https://api.example.com/b', { a: '' }, Schema, {
        label: 'test.put',
        headers: { Authorization: 'Bearer t' },
      }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'PUT', body: '{"a":""}' });
    expect(calls[0]?.headers['Content-Type']).toBe('application/json');
    expect(calls[0]?.headers.Authorization).toBe('Bearer t');
  });

  it('retries a failed PUT at most 3 times, then gives up', async () => {
    const { client, calls } = harness({ '/b': [json({}, 503)] }, keyed);
    await expect(
      client.putJson('https://api.example.com/b', {}, Schema, { label: 'test.put' }),
    ).rejects.toMatchObject({ code: 'http_status', status: 503 });
    expect(calls).toHaveLength(3);
  });

  it('does not follow a redirect on a PUT', async () => {
    const { client, calls } = harness(
      {
        '/b': [
          new Response('', { status: 307, headers: { location: 'https://api.example.com/c' } }),
        ],
      },
      keyed,
    );
    await expect(
      client.putJson('https://api.example.com/b', {}, Schema, { label: 'test.put' }),
    ).rejects.toMatchObject({ code: 'http_status', status: 307 });
    expect(calls).toHaveLength(1);
  });

  it('refuses plain http to any host that is not on the list, before any fetch', async () => {
    const h = harness({ '*': [json({ ok: true })] }, keyed);
    for (const url of [
      'http://api.example.com/a',
      'http://metadata.google.internal.evil.com/a',
      'http://evil.metadata.google.internal/a',
      'http://169.254.169.254/a',
    ]) {
      await expect(h.client.getJson(url, Schema, opts), url).rejects.toMatchObject({
        code: 'insecure_url',
      });
      await expect(h.client.putJson(url, {}, Schema, opts), url).rejects.toMatchObject({
        code: 'insecure_url',
      });
    }
    expect(h.calls).toHaveLength(0);
  });

  it('allows plain http to exactly the listed host', async () => {
    const h = harness({ '/a': [json({ ok: true })] }, { ...keyed, plainHttpHosts: ['meta.test'] });
    await expect(h.client.getJson('http://meta.test/a', Schema, opts)).resolves.toEqual({
      ok: true,
    });
    await expect(h.client.getJson('http://other.test/a', Schema, opts)).rejects.toMatchObject({
      code: 'insecure_url',
    });
  });

  it('does not let a redirect downgrade to plain http', async () => {
    const h = harness(
      {
        '/robots.txt': NO_ROBOTS,
        '/a': [
          new Response('', { status: 302, headers: { location: 'http://api.example.com/b' } }),
        ],
      },
      {},
    );
    await expect(h.client.getJson('https://api.example.com/a', Schema, opts)).rejects.toMatchObject(
      {
        code: 'http_status',
      },
    );
    expect(h.calls.map((call) => call.url)).not.toContain('http://api.example.com/b');
  });

  it('gives a default client no plain http at all, the metadata host included', async () => {
    const h = harness({ '*': [json({ ok: true })] }, keyed);
    await expect(
      h.client.getJson('http://metadata.google.internal/x', Schema, opts),
    ).rejects.toMatchObject({ code: 'insecure_url' });
    expect(h.calls).toHaveLength(0);
  });

  it('never follows a redirect to plain http, even to a host on the plain-http list', async () => {
    const h = harness(
      {
        '/a': [
          new Response('', {
            status: 302,
            headers: { location: 'http://metadata.google.internal/computeMetadata/v1/x' },
          }),
        ],
      },
      { ...keyed, plainHttpHosts: ['metadata.google.internal'] },
    );
    await expect(h.client.getJson('https://api.example.com/a', Schema, opts)).rejects.toMatchObject(
      { code: 'http_status' },
    );
    expect(h.calls.map((call) => new URL(call.url).host)).toEqual(['api.example.com']);
  });

  it('refuses a forbidden redirect target first, with a log line, over plain http and on a PUT', async () => {
    const h = harness({
      '/robots.txt': NO_ROBOTS,
      '/a': [
        new Response('', { status: 302, headers: { location: 'http://uk.linkedin.com/jobs/view/1' } }),
      ],
      '/b': [
        new Response('', { status: 307, headers: { location: 'https://uk.linkedin.com/jobs/view/1' } }),
      ],
    });
    await expect(h.client.getJson('https://api.example.com/a', Schema, opts)).rejects.toMatchObject(
      { code: 'forbidden_host' },
    );
    expect(h.logs.filter((entry) => entry.event === 'http.forbidden_host')).toHaveLength(1);
    await expect(
      h.client.putJson('https://api.example.com/b', {}, Schema, opts),
    ).rejects.toMatchObject({ code: 'forbidden_host' });
    expect(h.logs.filter((entry) => entry.event === 'http.forbidden_host')).toHaveLength(2);
    expect(h.calls.map((call) => new URL(call.url).host)).not.toContain('uk.linkedin.com');
  });

  it('matches the plain-http list on the exact host: port, userinfo and look-alike forms are refused', async () => {
    const h = harness(
      { '*': [json({ ok: true })] },
      { ...keyed, plainHttpHosts: ['metadata.google.internal'] },
    );
    for (const url of [
      'http://metadata.google.internal:8080/a',
      'http://user@metadata.google.internal/a',
      'http://user:pw@metadata.google.internal/a',
      'http://metadata.google.internal./a',
      'http://2852039166/a',
      'http://[::ffff:169.254.169.254]/a',
      'http://metadata.google.internal%2eevil.com/a',
    ]) {
      await expect(h.client.getJson(url, Schema, opts), url).rejects.toMatchObject({
        code: 'insecure_url',
      });
    }
    expect(h.calls).toHaveLength(0);
    await expect(
      h.client.getJson('http://METADATA.Google.Internal/a', Schema, opts),
    ).resolves.toEqual({ ok: true });
  });

  it('drops credentials on a cross-origin redirect and keeps them on a same-origin one', async () => {
    const redirect = (to: string) => new Response('', { status: 302, headers: { location: to } });
    const h = harness(
      {
        '/same': [redirect('/same2')],
        '/same2': [json({ ok: true })],
        '/cross': [redirect('https://other.example.net/landing')],
        '/landing': [json({ ok: true })],
      },
      keyed,
    );
    const headers = { Authorization: 'Bearer secret', 'metadata-flavor': 'Google', 'X-Keep': '1' };
    await h.client.getJson('https://api.example.com/same', Schema, { label: 'test', headers });
    const sameHop = h.calls.find((call) => call.url.endsWith('/same2'));
    expect(sameHop?.headers.Authorization).toBe('Bearer secret');
    await h.client.getJson('https://api.example.com/cross', Schema, { label: 'test', headers });
    const crossHop = h.calls.find((call) => call.url.endsWith('/landing'));
    expect(crossHop?.headers).not.toHaveProperty('Authorization');
    expect(crossHop?.headers).not.toHaveProperty('metadata-flavor');
    expect(crossHop?.headers['X-Keep']).toBe('1');
  });

  it('keeps refusing LinkedIn, Indeed, Wellfound and Glassdoor on the plain-http and PUT paths', async () => {
    const h = harness({ '*': [json({ ok: true })] }, keyed);
    for (const url of [
      'http://www.linkedin.com/a',
      'https://www.linkedin.com/a',
      'http://uk.indeed.com/a',
      'https://wellfound.com/a',
      'http://www.glassdoor.co.uk/a',
    ]) {
      await expect(h.client.getJson(url, Schema, opts), url).rejects.toMatchObject({
        code: 'forbidden_host',
      });
      await expect(h.client.putJson(url, {}, Schema, opts), url).rejects.toMatchObject({
        code: 'forbidden_host',
      });
    }
    expect(h.calls).toHaveLength(0);
  });
});
