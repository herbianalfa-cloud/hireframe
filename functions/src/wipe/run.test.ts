import { HttpsError } from 'firebase-functions/https';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLogSink, type LogFields } from '../log.js';
import { WIPE } from '../config.js';
import { deleteAllDataHandler } from './run.js';
import { memoryWipe, type MemoryWipe } from './testing.js';

const CONFIRMED = { confirm: 'DELETE', resetProfile: false };
const WITH_PROFILE = { confirm: 'DELETE', resetProfile: true };

let logs: LogFields[];
beforeEach(() => {
  logs = [];
  setLogSink((level, event, fields) => logs.push({ level, event, ...fields }));
});
afterEach(() => {
  setLogSink();
});

const call = (
  w: MemoryWipe,
  data: unknown,
  limits?: Parameters<typeof deleteAllDataHandler>[1]['limits'],
) =>
  deleteAllDataHandler(data, {
    store: w.store,
    reset: w.reset,
    now: () => w.clock.now,
    ...(limits ? { limits } : {}),
  });

async function refusal(promise: Promise<unknown>): Promise<HttpsError> {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpsError);
  return error as HttpsError;
}

/** Repeats the call the way the client does, to `done` or a safety limit. */
async function loop(w: MemoryWipe, data: unknown, limits?: Parameters<typeof call>[2]) {
  const results = [];
  for (let i = 0; i < 30; i += 1) {
    const result = await call(w, data, limits);
    results.push(result);
    if (result.done) break;
  }
  return results;
}

const total = (w: MemoryWipe) =>
  Object.values(w.docs).reduce((sum, list) => sum + list.length, 0) + w.files.length;

describe('input', () => {
  it.each([
    undefined,
    {},
    { confirm: 'DELETE' },
    { resetProfile: false },
    { confirm: 'delete', resetProfile: false },
    { confirm: 'DELETE', resetProfile: 'yes' },
    { confirm: 'DELETE', resetProfile: false, extra: 1 },
  ])('refuses %j with zero store calls', async (data) => {
    const w = memoryWipe({ jobs: 5 });
    const error = await refusal(call(w, data));
    expect(error.code).toBe('invalid-argument');
    expect(w.calls).toEqual([]);
    expect(w.docs.jobs).toHaveLength(5);
  });
});

describe('refusals (nothing is deleted)', () => {
  it('refuses when the lock is free on read but taken on acquire (a race)', async () => {
    const w = memoryWipe({ jobs: 3, runs: 2 });
    w.store.acquire = (): ReturnType<typeof w.store.acquire> => {
      w.calls.push('acquire');
      return Promise.resolve({ ok: false, holder: 'scan' });
    };
    const error = await refusal(call(w, CONFIRMED));
    expect(error.code).toBe('failed-precondition');
    expect(w.calls.filter((c) => c.startsWith('delete:'))).toEqual([]);
    expect(total(w)).toBe(5);
  });

  it.each([
    ['scan', 'A scan is already running.'],
    ['rescore', 'A scan is already running.'],
    ['email', 'Importing alerts, try again in a minute.'],
    ['lookup', 'Adding a job from Lookup, try again in a minute.'],
  ] as const)('refuses while %s holds the lock', async (holder, message) => {
    const w = memoryWipe({ jobs: 3, applications: 1 }, { files: 2 });
    w.lock.holder = holder;
    const error = await refusal(call(w, CONFIRMED));
    expect(error.code).toBe('failed-precondition');
    expect(error.message).toBe(message);
    expect(total(w)).toBe(6);
    expect(w.calls.some((c) => c.startsWith('delete'))).toBe(false);
  });

  it('refuses while a CV is being written', async () => {
    const w = memoryWipe({ jobs: 3 });
    w.generating = true;
    const error = await refusal(call(w, CONFIRMED));
    expect(error).toMatchObject({
      code: 'failed-precondition',
      message: 'Wait for the CV being written.',
    });
    expect(w.docs.jobs).toHaveLength(3);
  });

  it('refuses a ticked wipe while a CV is being read, on every call', async () => {
    const w = memoryWipe({ jobs: 3 });
    w.parsing = [
      {
        kind: 'pdf',
        storagePath: 'x',
        status: 'parsing',
        createdAt: new Date(w.clock.now.getTime() - 60_000),
        updatedAt: new Date(w.clock.now.getTime() - 60_000),
        schemaVersion: 1,
      },
    ];
    const error = await refusal(call(w, WITH_PROFILE));
    expect(error.message).toBe('A CV is being read. Try again when it has finished.');
    expect(w.docs.jobs).toHaveLength(3);
    // Unticked, the same parse doesn't matter.
    await expect(call(w, CONFIRMED)).resolves.toBeDefined();
  });

  it('takes over a stale lock (the store reads it as free)', async () => {
    const w = memoryWipe({ jobs: 1 });
    w.lock.holder = null;
    const [first] = await loop(w, CONFIRMED);
    expect(first?.deleted.documents).toBe(2);
  });

  it('keeps going while the wipe holds the lock itself', async () => {
    const w = memoryWipe({ jobs: 1 });
    w.lock.holder = 'wipe';
    await expect(call(w, CONFIRMED)).resolves.toMatchObject({ deleted: { documents: 2 } });
  });
});

describe('the pass', () => {
  it('deletes in a fixed order and finishes with a call that deletes nothing', async () => {
    const w = memoryWipe(
      { applications: 2, cvs: 2, jobs: 3, runs: 1, events: 4, alertMessages: 1, companies: 2 },
      { files: 3 },
    );
    w.sources.set('greenhouse', { status: 'ok', quota: { day: 'x' }, lastCounts: {} });
    w.sources.set('email', { status: 'ok', lastCounts: {}, bySender: {} });
    const results = await loop(w, CONFIRMED);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      done: false,
      remaining: [],
      deleted: { documents: 2 + 2 + 6 + 1 + 4 + 1 + 2 + 2, files: 3 },
    });
    expect(results[1]).toEqual({ done: true, deleted: { documents: 0, files: 0 }, remaining: [] });
    expect(total(w)).toBe(0);
    // The order of the delete pass is the plan's.
    const order = w.calls
      .filter((c) => c.startsWith('delete:'))
      .map((c) => c.slice(7))
      .filter((step, i, all) => all[i - 1] !== step);
    expect(order.slice(0, 9)).toEqual([
      'applications',
      'cvFiles',
      'cvs',
      'jobs',
      'runs',
      'events',
      'alertMessages',
      'companies',
      'sources',
    ]);
    // Done releases the lock; a further call is also done with nothing deleted.
    expect(w.lock.holder).toBeNull();
    await expect(call(w, CONFIRMED)).resolves.toMatchObject({
      done: true,
      deleted: { documents: 0, files: 0 },
    });
  });

  it('keeps quota and pausedHosts, and deletes a source doc with neither', async () => {
    const w = memoryWipe();
    const quota = { day: '2026-10-14', dayCount: 1 };
    const pausedHosts = [{ host: 'jobs.lever.co', until: new Date('2026-11-01T00:00:00Z') }];
    w.sources.set('adzuna', { status: 'ok', quota, lastCounts: {} });
    w.sources.set('lever', { status: 'ok', pausedHosts, lastCounts: {} });
    w.sources.set('email', { status: 'ok', bySender: {}, lastCounts: {} });
    await loop(w, CONFIRMED);
    expect([...w.sources.keys()].sort()).toEqual(['adzuna', 'lever']);
    expect(w.sources.get('adzuna')).toMatchObject({ quota, schemaVersion: 1 });
    expect(w.sources.get('adzuna')).not.toHaveProperty('status');
    expect(w.sources.get('lever')).toMatchObject({ pausedHosts });
  });

  it('holds the lock between calls and releases it only when done', async () => {
    const w = memoryWipe({ jobs: 5000 });
    const first = await call(w, CONFIRMED);
    expect(first.done).toBe(false);
    expect(w.lock.holder).toBe('wipe');
    expect(w.calls.filter((c) => c === 'acquire').length).toBeGreaterThanOrEqual(2);
    const rest = await loop(w, CONFIRMED);
    expect(rest.at(-1)?.done).toBe(true);
    expect(w.lock.holder).toBeNull();
  });

  it('is never done in a call that deleted something', async () => {
    const w = memoryWipe({ events: 1 });
    const result = await call(w, CONFIRMED);
    expect(result).toMatchObject({ done: false, remaining: [], deleted: { documents: 1 } });
  });
});

describe('bounds', () => {
  it('deletes at most 3,000 documents a call: 5,000 take two calls and a check', async () => {
    const w = memoryWipe({ events: 5000 });
    const first = await call(w, CONFIRMED);
    expect(first).toMatchObject({ done: false, deleted: { documents: WIPE.maxDocuments } });
    // The cap stopped events, so the steps after it were never reached: not confirmed.
    expect(first.remaining).toEqual(['events', 'alertMessages', 'companies', 'sources']);
    const second = await call(w, CONFIRMED);
    expect(second).toMatchObject({ done: false, deleted: { documents: 2000 }, remaining: [] });
    await expect(call(w, CONFIRMED)).resolves.toMatchObject({ done: true });
  });

  it('lists at most 20 Storage pages of 200 a call', async () => {
    const w = memoryWipe({}, { files: 5000 });
    const first = await call(w, CONFIRMED);
    expect(first.deleted.files).toBe(20 * 200);
    expect(first.remaining).toEqual(['cvFiles']);
    expect(w.files).toHaveLength(1000);
    const results = await loop(w, CONFIRMED);
    expect(results.at(-1)?.done).toBe(true);
  });

  it('starts no new page after 90 s', async () => {
    const w = memoryWipe({ runs: 1000, events: 10 });
    w.pageMs = 40_000;
    w.slow = 'runs';
    const result = await call(w, CONFIRMED);
    // Pages at 0 s, 40 s and 80 s start; the one at 120 s doesn't, nor does any later step.
    expect(w.calls.filter((c) => c === 'delete:runs')).toHaveLength(3);
    expect(w.calls).not.toContain('delete:events');
    expect(result.done).toBe(false);
    expect(result.deleted.documents).toBe(600);
    expect(result.remaining).toEqual(
      expect.arrayContaining(['runs', 'events', 'alertMessages', 'companies', 'sources']),
    );
    // The check pass starts nothing either: past the deadline every step is "not confirmed".
    expect(w.calls.some((c) => c.startsWith('has:'))).toBe(false);
    expect(w.docs.runs).toHaveLength(400);
  });

  it('finishes over several calls with small injected limits', async () => {
    const w = memoryWipe({ jobs: 30, events: 25 }, { files: 9 });
    const results = await loop(w, CONFIRMED, {
      maxDocuments: 10,
      pageSize: 4,
      maxStoragePages: 2,
      storagePageSize: 3,
    });
    expect(results.length).toBeGreaterThan(4);
    expect(results.at(-1)?.done).toBe(true);
    expect(total(w)).toBe(0);
  });
});

describe('exact cap', () => {
  it('never deletes more than the cap, even with one document of room at the jobs step', async () => {
    const w = memoryWipe({ events: 3, jobs: 10 });
    const results = await loop(w, CONFIRMED, { maxDocuments: 5, pageSize: 200 });
    for (const result of results) {
      expect(result.deleted.documents).toBeLessThanOrEqual(5);
    }
    // The first call: 3 events leave room for one job and its description (2 of the 2 left),
    // then the odd remainder stops the step instead of taking a third document.
    expect(results[0]?.deleted.documents).toBe(5);
    expect(results.at(-1)?.done).toBe(true);
    expect(total(w)).toBe(0);
  });

  it('marks jobs unfinished when only one document of cap is left', async () => {
    const w = memoryWipe({ events: 4, jobs: 10 });
    const first = await call(w, CONFIRMED, { maxDocuments: 5 });
    // Two jobs and their descriptions (4), then one document of room: the jobs step stops short
    // and the one document goes to the next step.
    expect(first.remaining).toContain('jobs');
    expect(w.docs.jobs).toHaveLength(8);
    expect(w.docs.events).toHaveLength(3);
    expect(first.deleted.documents).toBe(5);
  });
});

describe('concurrent writes and failures', () => {
  it('catches an application written after step 1 on the next call', async () => {
    const w = memoryWipe({ applications: 1, jobs: 600 });
    w.beforePage = (step, n) => {
      if (step === 'jobs' && n === 2) w.docs.applications.push('late');
    };
    const first = await call(w, CONFIRMED);
    expect(first.done).toBe(false);
    expect(first.remaining).toEqual(['applications']);
    const second = await call(w, CONFIRMED);
    expect(second.deleted.documents).toBe(1);
    expect(second.done).toBe(false);
    const third = await call(w, CONFIRMED);
    expect(third.done).toBe(true);
    expect(w.docs.applications).toHaveLength(0);
  });

  it('completes on a second call after a store error mid-jobs, and a third is done', async () => {
    const w = memoryWipe({ jobs: 50, runs: 3 });
    w.failOnce = 'jobs';
    await expect(call(w, CONFIRMED)).rejects.toThrow('store unavailable');
    expect(w.docs.jobs).toHaveLength(50);
    // The lock is kept for the retry; nothing depends on stored progress.
    expect(w.lock.holder).toBe('wipe');
    const second = await call(w, CONFIRMED);
    expect(second).toMatchObject({ done: false, remaining: [] });
    const third = await call(w, CONFIRMED);
    expect(third).toEqual({ done: true, deleted: { documents: 0, files: 0 }, remaining: [] });
  });
});

describe('the profile (ticked)', () => {
  it('runs only in the pass that found the other steps empty', async () => {
    const w = memoryWipe({ jobs: 5000 });
    w.profile = { facts: 40, documents: 2, files: 1 };
    const first = await call(w, WITH_PROFILE);
    expect(first.profile).toBeUndefined();
    expect(w.calls).not.toContain('deleteProfile');
    expect(w.profile.facts).toBe(40);
    const results = await loop(w, WITH_PROFILE);
    const withProfile = results.filter((r) => r.profile);
    expect(withProfile[0]?.profile).toEqual({ facts: 40, documents: 2, files: 1 });
    expect(results.at(-1)).toMatchObject({ done: true, deleted: { documents: 0, files: 0 } });
    expect(w.profile).toEqual({ facts: 0, documents: 0, files: 0 });
  });

  it('runs on the pass that deleted the last jobs, and is done only on a later clean pass (D1)', async () => {
    const w = memoryWipe({ jobs: 3 });
    w.profile = { facts: 4, documents: 1, files: 0 };
    const first = await call(w, WITH_PROFILE);
    expect(first.done).toBe(false);
    expect(first.deleted.documents).toBe(6 + 5);
    expect(first.profile).toEqual({ facts: 4, documents: 1, files: 0 });
    expect(first.remaining).toEqual([]);
    const second = await call(w, WITH_PROFILE);
    expect(second).toMatchObject({ done: true, deleted: { documents: 0, files: 0 } });
  });

  it('does not start after 90 s, and a call that skipped it is not done', async () => {
    const w = memoryWipe({});
    w.profile = { facts: 4, documents: 1, files: 0 };
    const hasAny = w.store.hasAny.bind(w.store);
    // The last read of the check pass lands past the deadline.
    w.store.hasAny = async (step) => {
      const found = await hasAny(step);
      if (step === 'sources') w.clock.now = new Date(w.clock.now.getTime() + 95_000);
      return found;
    };
    const result = await call(w, WITH_PROFILE);
    expect(result).toMatchObject({ done: false, remaining: [] });
    expect(result.profile).toBeUndefined();
    expect(w.calls).not.toContain('deleteProfile');
    expect(w.lock.holder).toBe('wipe');
  });

  it('is not touched when unticked', async () => {
    const w = memoryWipe({ jobs: 2 });
    w.profile = { facts: 40, documents: 2, files: 1 };
    await loop(w, CONFIRMED);
    expect(w.calls).not.toContain('deleteProfile');
    expect(w.profile.facts).toBe(40);
  });
});

describe('logging', () => {
  it('logs counts only', async () => {
    const w = memoryWipe({ jobs: 2 });
    await call(w, CONFIRMED);
    expect(logs).toContainEqual({
      level: 'info',
      event: 'wipe.pass',
      documents: 4,
      files: 0,
      remaining: 0,
      done: false,
    });
  });
});
