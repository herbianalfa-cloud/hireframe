import { Timestamp } from 'firebase/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetMarksForTest } from '@/lib/perf';

import { checkAccess, evaluateAccess, type AppConfigRead } from './access';
import { timestampsToDates } from './timestamps';

const OWNER = 'owner-uid-123';

/** Shaped like the `config/app` doc created by hand in the Firebase console (RUNBOOK). */
function consoleConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ownerUid: OWNER,
    schemaVersion: 1,
    createdAt: Timestamp.fromDate(new Date('2026-09-30T08:00:00Z')),
    updatedAt: Timestamp.fromDate(new Date('2026-09-30T08:05:00Z')),
    ...overrides,
  };
}

const read =
  (data: unknown): (() => Promise<AppConfigRead>) =>
  () =>
    Promise.resolve({ exists: true, data });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('timestampsToDates', () => {
  it('converts Firestore Timestamps to Dates, including nested ones', () => {
    const at = new Date('2026-09-30T08:00:00Z');
    const converted = timestampsToDates({
      createdAt: Timestamp.fromDate(at),
      nested: { list: [Timestamp.fromDate(at), 'text'] },
      count: 3,
    });
    expect(converted).toEqual({ createdAt: at, nested: { list: [at, 'text'] }, count: 3 });
  });
});

describe('evaluateAccess', () => {
  it('treats a missing config/app as denied', () => {
    expect(evaluateAccess(OWNER, { exists: false })).toEqual({ status: 'denied' });
  });
});

describe('checkAccess', () => {
  it('marks hf:owner once the check resolves, owner or not', async () => {
    resetMarksForTest();
    await checkAccess('someone-else', read(consoleConfig()));
    expect(performance.getEntriesByName('hf:owner')).toHaveLength(1);
  });

  it('converts console Timestamps before parsing and returns owner for the matching UID', async () => {
    await expect(checkAccess(OWNER, read(consoleConfig()))).resolves.toEqual({ status: 'owner' });
  });

  it('returns denied for a different UID', async () => {
    await expect(checkAccess('someone-else', read(consoleConfig()))).resolves.toEqual({
      status: 'denied',
    });
  });

  it('returns denied when the rules reject the read (permission-denied)', async () => {
    const denied = () =>
      Promise.reject(
        Object.assign(new Error('Missing or insufficient permissions.'), {
          code: 'permission-denied',
        }),
      );
    await expect(checkAccess(OWNER, denied)).resolves.toEqual({ status: 'denied' });
  });

  it.each([
    ['a missing timestamp', consoleConfig({ updatedAt: undefined })],
    ['a string instead of a Timestamp', consoleConfig({ createdAt: '2026-09-30' })],
    ['an empty ownerUid', consoleConfig({ ownerUid: '' })],
  ])('returns error, never owner, for a malformed doc with %s', async (_name, data) => {
    const access = await checkAccess(OWNER, read(data));
    expect(access.status).toBe('error');
  });

  it('returns error (not denied or owner) when the read keeps failing', async () => {
    const offline = vi.fn(() =>
      Promise.reject(Object.assign(new Error('offline'), { code: 'failed-precondition' })),
    );
    const access = await checkAccess(OWNER, offline);
    expect(access.status).toBe('error');
    expect(offline).toHaveBeenCalledTimes(1);
  });
});
