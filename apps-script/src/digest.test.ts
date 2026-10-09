import { DIGEST_STATES } from '@hireframe/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  DIGEST_STATE_NAMES,
  LAST_DIGEST_DAY,
  digestFallback,
  digestMorning,
  digestNow,
  type DigestDeps,
  type DigestMail,
} from './digest.js';

// 2026-10-07 is a Wednesday in BST (UTC+1); 06:50Z is 07:50 London.
const WEDNESDAY = Date.parse('2026-10-07T06:50:00Z');
const SATURDAY = Date.parse('2026-10-10T06:50:00Z');
const SUNDAY = Date.parse('2026-10-11T06:50:00Z');

const londonDay = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(ms));
const isoWeekday = (ms: number) => {
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short' })
    .format(new Date(ms))
    .slice(0, 3);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name) + 1;
};

const ready = (state = 'ready') =>
  JSON.stringify({ state, subject: 'Hireframe Wed 7 Oct', html: '<p>Hi</p>', text: 'Hi' });

interface Harness {
  deps: DigestDeps;
  mails: DigestMail[];
  posts: { kind: string; day: string }[];
  props: Record<string, string>;
  lock: { tryLock: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
}

function harness(
  options: {
    now?: number;
    response?: { status: number; body: string } | Error;
    props?: Record<string, string>;
    lockFree?: boolean;
    sendFails?: boolean;
  } = {},
): Harness {
  const mails: DigestMail[] = [];
  const posts: { kind: string; day: string }[] = [];
  const props: Record<string, string> = { ...options.props };
  const lock = {
    tryLock: vi.fn(() => options.lockFree ?? true),
    release: vi.fn(),
  };
  const deps: DigestDeps = {
    now: () => options.now ?? WEDNESDAY,
    london: { day: londonDay, isoWeekday },
    props: {
      get: (name) => props[name] ?? null,
      set: (name, value) => void (props[name] = value),
    },
    post(body) {
      posts.push(JSON.parse(Buffer.from(body).toString('utf8')) as { kind: string; day: string });
      const response = options.response ?? { status: 200, body: ready() };
      if (response instanceof Error) throw response;
      return response;
    },
    signer: { headers: () => ({ 'X-Hireframe-Signature': 'sig' }) },
    uuid: () => 'nonce',
    sendMail(mail) {
      if (options.sendFails) throw new Error('quota');
      mails.push(mail);
    },
    lock,
  };
  return { deps, mails, posts, props, lock };
}

describe('the state names', () => {
  it('match the server’s', () => {
    expect([...DIGEST_STATE_NAMES]).toEqual([...DIGEST_STATES]);
  });
});

describe('digestMorning', () => {
  it.each([
    ['Saturday', SATURDAY],
    ['Sunday', SUNDAY],
  ])('does nothing on %s, not even a request', (_name, now) => {
    const h = harness({ now });
    expect(digestMorning(h.deps)).toEqual({ sent: false, skipped: 'weekend' });
    expect(h.posts).toEqual([]);
    expect(h.mails).toEqual([]);
  });

  it('uses the London day: just after midnight BST on Saturday is Saturday', () => {
    // 23:30Z on Friday 9 Oct is 00:30 on Saturday 10 Oct in London.
    const h = harness({ now: Date.parse('2026-10-09T23:30:00Z') });
    expect(digestMorning(h.deps).skipped).toBe('weekend');
  });

  it.each(['ready', 'failed', 'missing'])('mails a %s digest and marks the day', (state) => {
    const h = harness({ response: { status: 200, body: ready(state) } });
    expect(digestMorning(h.deps)).toEqual({ sent: true, state });
    expect(h.posts).toEqual([{ kind: 'morning', day: '2026-10-07' }]);
    expect(h.mails).toEqual([{ subject: 'Hireframe Wed 7 Oct', html: '<p>Hi</p>', text: 'Hi' }]);
    expect(h.props[LAST_DIGEST_DAY]).toBe('2026-10-07');
  });

  it('mails nothing on in_progress and leaves the day unmarked, for the fallback', () => {
    const h = harness({ response: { status: 200, body: ready('in_progress') } });
    expect(digestMorning(h.deps)).toEqual({ sent: false, skipped: 'in_progress' });
    expect(h.mails).toEqual([]);
    expect(h.props[LAST_DIGEST_DAY]).toBeUndefined();
  });

  it('does nothing when today’s digest was already sent', () => {
    const h = harness({ props: { [LAST_DIGEST_DAY]: '2026-10-07' } });
    expect(digestMorning(h.deps)).toEqual({ sent: false, skipped: 'already_sent' });
    expect(h.posts).toEqual([]);
  });

  it('sends again the next day', () => {
    const h = harness({ props: { [LAST_DIGEST_DAY]: '2026-10-06' } });
    expect(digestMorning(h.deps).sent).toBe(true);
  });

  it.each([
    ['a network error', new Error('dns')],
    ['a 401', { status: 401, body: '{"error":"unauthorized"}' }],
    ['a 500', { status: 500, body: '{"error":"internal"}' }],
    ['a bad body', { status: 200, body: '<html>' }],
    ['a body missing a field', { status: 200, body: '{"state":"ready"}' }],
    [
      'an unknown state',
      { status: 200, body: JSON.stringify({ state: 'done', subject: 's', html: 'h', text: 't' }) },
    ],
  ])('mails nothing and makes one request only after %s', (_name, response) => {
    const h = harness({ response });
    expect(digestMorning(h.deps)).toEqual({ sent: false, skipped: 'request_failed' });
    expect(h.posts).toHaveLength(1);
    expect(h.mails).toEqual([]);
    expect(h.props[LAST_DIGEST_DAY]).toBeUndefined();
  });

  it('does not mark the day when the mail can’t be sent, so the fallback tries', () => {
    const h = harness({ sendFails: true });
    expect(digestMorning(h.deps)).toEqual({ sent: false, skipped: 'send_failed' });
    expect(h.props[LAST_DIGEST_DAY]).toBeUndefined();
  });

  it('strips line breaks from the subject', () => {
    const h = harness({
      response: {
        status: 200,
        body: JSON.stringify({ state: 'ready', subject: 'A\r\nBcc: x', html: 'h', text: 't' }),
      },
    });
    digestMorning(h.deps);
    expect(h.mails[0]?.subject).toBe('A Bcc: x');
  });
});

describe('digestFallback', () => {
  it('sends after a skipped morning, including the in-progress notice', () => {
    const h = harness({ response: { status: 200, body: ready('in_progress') } });
    expect(digestFallback(h.deps)).toEqual({ sent: true, state: 'in_progress' });
    expect(h.posts).toEqual([{ kind: 'fallback', day: '2026-10-07' }]);
    expect(h.mails).toHaveLength(1);
    expect(h.props[LAST_DIGEST_DAY]).toBe('2026-10-07');
  });

  it('does nothing after a morning that was sent', () => {
    const h = harness();
    digestMorning(h.deps);
    const second = digestFallback(h.deps);
    expect(second).toEqual({ sent: false, skipped: 'already_sent' });
    expect(h.mails).toHaveLength(1);
    expect(h.posts).toHaveLength(1);
  });

  it('does nothing at the weekend', () => {
    const h = harness({ now: SATURDAY });
    expect(digestFallback(h.deps)).toEqual({ sent: false, skipped: 'weekend' });
    expect(h.posts).toEqual([]);
  });

  it.each([
    ['a network error', new Error('dns'), 'network_error'],
    ['a 503', { status: 503, body: '' }, 'http_503'],
    ['a 401', { status: 401, body: '{"error":"unauthorized"}' }, 'http_401'],
    ['a bad body', { status: 200, body: '{}' }, 'bad_response'],
  ])('mails its own "unavailable" email after %s', (_name, response, code) => {
    const h = harness({ response });
    expect(digestFallback(h.deps)).toEqual({ sent: true, state: 'unavailable' });
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0]?.subject).toBe(`Hireframe digest unavailable (${code})`);
    expect(h.mails[0]?.text).toContain('2026-10-07');
    expect(h.mails[0]?.html).toBeUndefined();
    expect(h.props[LAST_DIGEST_DAY]).toBe('2026-10-07');
  });

  it('makes one request after a failure: no retry', () => {
    const h = harness({ response: new Error('dns') });
    digestFallback(h.deps);
    expect(h.posts).toHaveLength(1);
  });

  it('fails the execution when even the mail can’t be sent, and still releases the lock', () => {
    const h = harness({ sendFails: true });
    expect(() => digestFallback(h.deps)).toThrow('digest_send_failed');
    expect(h.props[LAST_DIGEST_DAY]).toBeUndefined();
    expect(h.lock.release).toHaveBeenCalledTimes(1);
  });
});

describe('the lock', () => {
  it('sends nothing and posts nothing when the lock can’t be had', () => {
    for (const handler of [digestMorning, digestFallback]) {
      const h = harness({ lockFree: false });
      expect(handler(h.deps)).toEqual({ sent: false, skipped: 'locked' });
      expect(h.posts).toEqual([]);
      expect(h.mails).toEqual([]);
      expect(h.lock.release).not.toHaveBeenCalled();
    }
  });

  it('is released after every run, including a failed request', () => {
    const h = harness({ response: new Error('dns') });
    digestMorning(h.deps);
    expect(h.lock.release).toHaveBeenCalledTimes(1);
  });

  it('prevents a double send: two triggers that overlap send one digest', () => {
    // The second handler runs while the first holds the lock: it can't get it and gives up.
    const h = harness();
    let held = false;
    h.lock.tryLock.mockImplementation(() => {
      if (held) return false;
      held = true;
      return true;
    });
    h.lock.release.mockImplementation(() => {
      held = false;
    });
    const post = h.deps.post;
    let inner: unknown;
    h.deps.post = (body, headers) => {
      inner = digestFallback(h.deps);
      return post(body, headers);
    };
    expect(digestMorning(h.deps).sent).toBe(true);
    expect(inner).toEqual({ sent: false, skipped: 'locked' });
    expect(h.mails).toHaveLength(1);
  });
});

describe('digestNow', () => {
  it('mails a fallback digest on a Saturday and leaves lastDigestDay alone', () => {
    const h = harness({ now: SATURDAY, props: { [LAST_DIGEST_DAY]: '2026-10-10' } });
    expect(digestNow(h.deps)).toEqual({ sent: true, state: 'ready' });
    expect(h.posts).toEqual([{ kind: 'fallback', day: '2026-10-10' }]);
    expect(h.props[LAST_DIGEST_DAY]).toBe('2026-10-10');
  });

  it('mails the unavailable notice when the request fails', () => {
    const h = harness({ response: { status: 500, body: '' } });
    digestNow(h.deps);
    expect(h.mails[0]?.subject).toBe('Hireframe digest unavailable (http_500)');
  });
});

describe('the request', () => {
  it('is {"kind","day"} signed with the injected signer, once per run', () => {
    const headers = vi.fn(() => ({ 'X-Hireframe-Signature': 'sig' }));
    const h = harness();
    h.deps.signer = { headers };
    digestMorning(h.deps);
    expect(headers).toHaveBeenCalledWith(
      [...Buffer.from('{"kind":"morning","day":"2026-10-07"}')],
      Math.floor(WEDNESDAY / 1000),
      'nonce',
    );
  });
});
