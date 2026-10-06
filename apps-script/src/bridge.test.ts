import { INGEST_WIRE } from '../../packages/shared/src/signing.js';
import { describe, expect, it } from 'vitest';

import {
  batchByBytes,
  bodyFor,
  fitToLimit,
  PENDING_QUERY,
  runBridge,
  type BridgeDeps,
  type BridgeMessage,
} from './bridge.js';
import { createSigner } from './sign.js';

const bytes = (text: string) => new TextEncoder().encode(text).length;

function message(id: string, overrides: Partial<BridgeMessage> = {}): BridgeMessage {
  return {
    id,
    receivedAt: '2026-10-07T08:00:00.000Z',
    from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
    text: `text ${id}`,
    html: `<p>html ${id}</p>`,
    ...overrides,
  };
}

interface Harness {
  deps: BridgeDeps;
  posts: { body: string; headers: Record<string, string> }[];
  done: string[];
  fetched: string[];
}

function harness(
  messages: Record<string, BridgeMessage>,
  options: {
    listed?: string[];
    respond?: (body: string, call: number) => { status: number; body: string } | Error;
  } = {},
): Harness {
  const posts: Harness['posts'] = [];
  const done: string[] = [];
  const fetched: string[] = [];
  const respond =
    options.respond ??
    ((body: string) => {
      const sent = (JSON.parse(body) as { messages: { id: string }[] }).messages;
      return {
        status: 200,
        body: JSON.stringify({ results: sent.map(({ id }) => ({ id, status: 'processed' })) }),
      };
    });
  const deps: BridgeDeps = {
    // Gmail lists newest first.
    listPendingIds: () => options.listed ?? Object.keys(messages).reverse(),
    getMessage: (id) => {
      fetched.push(id);
      return messages[id] ?? null;
    },
    markDone: (id) => {
      done.push(id);
    },
    post: (payload, headers) => {
      // The bridge posts UTF-8 bytes; the tests read them back as the text they carry.
      const body = Buffer.from(payload).toString('utf8');
      posts.push({ body, headers });
      const result = respond(body, posts.length);
      if (result instanceof Error) throw result;
      return result;
    },
    signer: createSigner('secret', () => [1, 2, 3]),
    uuid: () => '3b241101-e2bb-4255-8caf-4136c566a962',
    now: () => 1_760_000_000_000,
  };
  return { deps, posts, done, fetched };
}

const many = (count: number, make: (id: string) => BridgeMessage = message) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => {
      const id = `m${String(i + 1).padStart(2, '0')}`;
      return [id, make(id)];
    }),
  );

describe('what leaves the script', () => {
  it('sends only id, receivedAt, from, text and html: no subject, recipient or other header', () => {
    const leaky = {
      ...message('m1'),
      subject: 'Your alert',
      to: 'someone@example.com',
      cc: 'other@example.com',
      deliveredTo: 'x@example.com',
      headers: { 'Delivered-To': 'x@example.com' },
    } as BridgeMessage;
    const h = harness({ m1: leaky });
    runBridge(h.deps);
    const sent = (JSON.parse(h.posts[0]?.body ?? '{}') as { messages: object[] }).messages;
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0] ?? {}).sort()).toEqual(['from', 'html', 'id', 'receivedAt', 'text']);
    expect(h.posts[0]?.body).not.toMatch(/subject|someone@|Delivered/i);
  });

  it('asks Gmail for pending alerts only', () => {
    expect(PENDING_QUERY).toBe('label:hireframe/alerts -label:hireframe/done');
  });

  it('signs each body with a fresh header set', () => {
    const h = harness(many(1));
    runBridge(h.deps);
    expect(Object.keys(h.posts[0]?.headers ?? {}).sort()).toEqual([
      'X-Hireframe-Nonce',
      'X-Hireframe-Signature',
      'X-Hireframe-Timestamp',
    ]);
    expect(h.posts[0]?.headers['X-Hireframe-Timestamp']).toBe('1760000000');
  });
});

describe('batching by bytes', () => {
  it('sends six small messages in two POSTs of at most five', () => {
    const h = harness(many(6));
    const summary = runBridge(h.deps);
    expect(h.posts).toHaveLength(2);
    expect(
      h.posts.map((p) => (JSON.parse(p.body) as { messages: unknown[] }).messages.length),
    ).toEqual([5, 1]);
    expect(summary).toMatchObject({ listed: 6, sent: 6, posts: 2, relabelled: 6 });
  });

  it('keeps every POST body under 900 kB in UTF-8 bytes, multi-byte characters included', () => {
    // 2-byte characters: 400k characters is about 800 kB each.
    const big = (id: string) =>
      message(id, { html: 'é'.repeat(300_000), text: 'é'.repeat(100_000) });
    const h = harness(many(3, big));
    runBridge(h.deps);
    expect(h.posts).toHaveLength(3);
    for (const post of h.posts) {
      expect(bytes(post.body)).toBeLessThanOrEqual(INGEST_WIRE.maxPostBytes);
    }
  });

  it('packs two 400 kB ASCII messages together and starts a new POST for the third', () => {
    const big = (id: string) =>
      message(id, { html: 'a'.repeat(300_000), text: 'a'.repeat(100_000) });
    const batches = batchByBytes(Object.values(many(3, big)));
    expect(batches.map((b) => b.length)).toEqual([2, 1]);
    for (const batch of batches) expect(bytes(bodyFor(batch))).toBeLessThanOrEqual(900_000);
  });

  it('truncates a single oversize message to fit, html first, and sends it alone', () => {
    // 3-byte characters: 300k of them are 900 kB on their own.
    const huge = message('m1', { html: '日'.repeat(300_000), text: 'é'.repeat(100_000) });
    const fitted = fitToLimit(huge, INGEST_WIRE.maxPostBytes);
    expect(bytes(bodyFor([fitted]))).toBeLessThanOrEqual(INGEST_WIRE.maxPostBytes);
    expect(fitted.text).toBe(huge.text); // text survived whole, html took the cut
    expect(fitted.html.length).toBeLessThan(huge.html.length);
    const h = harness({ m1: huge, m2: message('m2') });
    runBridge(h.deps);
    expect(h.posts).toHaveLength(2);
    expect((JSON.parse(h.posts[0]?.body ?? '{}') as { messages: unknown[] }).messages).toHaveLength(
      1,
    );
  });

  it('cuts text too when html alone cannot make it fit', () => {
    const fitted = fitToLimit(message('m1', { html: '', text: 'é'.repeat(100_000) }), 50_000);
    expect(bytes(bodyFor([fitted]))).toBeLessThanOrEqual(50_000);
    expect(fitted.text.length).toBeGreaterThan(0);
    expect(fitted.text.length).toBeLessThan(100_000);
  });

  it('never ends a cut on half of an emoji', () => {
    const fitted = fitToLimit(message('m1', { html: '😀'.repeat(1_000), text: '' }), 1_503);
    expect(fitted.html).not.toMatch(/[\ud800-\udbff]$/);
    expect(bytes(bodyFor([fitted]))).toBeLessThanOrEqual(1_503);
  });
});

describe('caps', () => {
  it('takes at most 20 messages a run, the oldest first', () => {
    const h = harness(many(25));
    runBridge(h.deps);
    expect(h.fetched).toHaveLength(20);
    expect(h.fetched[0]).toBe('m01');
    expect(h.fetched.at(-1)).toBe('m20');
    expect(h.posts).toHaveLength(4);
  });

  it('cuts each body to the wire limits', () => {
    const h = harness({
      m1: message('m1', { text: 'a'.repeat(150_000), html: 'b'.repeat(350_000) }),
    });
    runBridge(h.deps);
    const sent = (JSON.parse(h.posts[0]?.body ?? '{}') as { messages: BridgeMessage[] })
      .messages[0];
    expect(sent?.text.length).toBe(INGEST_WIRE.textChars);
    expect(sent?.html.length).toBeLessThanOrEqual(INGEST_WIRE.htmlChars);
  });
});

describe('relabelling', () => {
  const answer = (status: string) => (body: string) => ({
    status: 200,
    body: JSON.stringify({
      results: (JSON.parse(body) as { messages: { id: string }[] }).messages.map(({ id }) => ({
        id,
        status,
      })),
    }),
  });

  it.each(['processed', 'duplicate', 'unparsed'])('relabels on %s', (status) => {
    const h = harness(many(2), { respond: answer(status) });
    runBridge(h.deps);
    expect(h.done.sort()).toEqual(['m01', 'm02']);
  });

  it('leaves a deferred message labelled', () => {
    const h = harness(many(2), { respond: answer('deferred') });
    const summary = runBridge(h.deps);
    expect(h.done).toEqual([]);
    expect(summary.relabelled).toBe(0);
  });

  it('relabels per message, not per request', () => {
    const h = harness(many(2), {
      respond: () => ({
        status: 200,
        body: JSON.stringify({
          results: [
            { id: 'm01', status: 'processed' },
            { id: 'm02', status: 'deferred' },
          ],
        }),
      }),
    });
    runBridge(h.deps);
    expect(h.done).toEqual(['m01']);
  });

  it('never relabels an ID it did not send', () => {
    const h = harness(many(1), {
      respond: () => ({
        status: 200,
        body: JSON.stringify({ results: [{ id: 'zzz', status: 'processed' }] }),
      }),
    });
    runBridge(h.deps);
    expect(h.done).toEqual([]);
  });

  it.each([
    ['busy', { status: 503, body: '{"error":"busy"}' }, 'busy'],
    ['a 5xx', { status: 500, body: '' }, 'http_error'],
    ['a 401', { status: 401, body: '{"error":"unauthorized"}' }, 'http_error'],
    ['a malformed 200', { status: 200, body: 'not json' }, 'bad_response'],
    ['a network error', new Error('dns'), 'network_error'],
    ['a timeout', new Error('Timeout: request took too long'), 'network_error'],
  ])('leaves every label on %s and stops', (_name, response, stopped) => {
    const h = harness(many(6), { respond: () => response });
    const summary = runBridge(h.deps);
    expect(h.done).toEqual([]);
    expect(summary.stopped).toBe(stopped);
    expect(h.posts).toHaveLength(1); // no point sending the rest
  });

  it('logs a fixed code for each way a post fails, and never the response body', () => {
    const logged: { event: string; fields: Record<string, number | string> }[] = [];
    for (const response of [
      { status: 200, body: 'SECRET not json' },
      { status: 500, body: 'SECRET oops' },
      { status: 503, body: 'SECRET busy' },
    ]) {
      const h = harness(many(2), { respond: () => response });
      runBridge({ ...h.deps, log: (event, fields) => logged.push({ event, fields }) });
    }
    expect(logged).toEqual([
      { event: 'bridge.post_failed', fields: { reason: 'bad_response', status: 200 } },
      { event: 'bridge.post_failed', fields: { reason: 'http_error', status: 500 } },
      { event: 'bridge.post_failed', fields: { reason: 'busy' } },
    ]);
    expect(JSON.stringify(logged)).not.toContain('SECRET');
  });

  it('skips a message Gmail cannot return, and sends the rest', () => {
    const h = harness({ m1: message('m1') }, { listed: ['m2', 'm1'] });
    const summary = runBridge(h.deps);
    expect(summary).toMatchObject({ listed: 2, sent: 1 });
  });

  it('does nothing when there is nothing pending', () => {
    const h = harness({}, { listed: [] });
    expect(runBridge(h.deps)).toEqual({ listed: 0, sent: 0, posts: 0, relabelled: 0 });
    expect(h.posts).toHaveLength(0);
  });
});
