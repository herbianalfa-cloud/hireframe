import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetMarksForTest } from '@/lib/perf';

import { checkAccess, evaluateAccess, type AppConfigRead } from './access';

const boot = vi.hoisted(() => ({
  getFirebase: vi.fn(),
  loadFirestoreBoot: vi.fn(),
  readAppConfig: vi.fn(),
}));
vi.mock('./firebase', () => ({
  getFirebase: boot.getFirebase,
  loadFirestoreBoot: boot.loadFirestoreBoot,
}));

const OWNER = 'owner-uid-123';

/** The `config/app` doc as `readAppConfig` returns it: console Timestamps already Dates. */
function consoleConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ownerUid: OWNER,
    schemaVersion: 1,
    createdAt: new Date('2026-09-30T08:00:00Z'),
    updatedAt: new Date('2026-09-30T08:05:00Z'),
    ...overrides,
  };
}

const read =
  (data: unknown): (() => Promise<AppConfigRead>) =>
  () =>
    Promise.resolve({ exists: true, data });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  boot.getFirebase.mockReset().mockResolvedValue({ db: { kind: 'db' } });
  boot.loadFirestoreBoot.mockReset().mockResolvedValue({ readAppConfig: boot.readAppConfig });
  boot.readAppConfig.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it('returns owner for the matching UID', async () => {
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
    ['a string instead of a date', consoleConfig({ createdAt: '2026-09-30' })],
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

describe('checkAccess with the default reader (lazy Firestore boot, ADR-066)', () => {
  it('reads config/app through the Firestore chunk and returns owner', async () => {
    boot.readAppConfig.mockResolvedValue({ exists: true, data: consoleConfig() });
    await expect(checkAccess(OWNER)).resolves.toEqual({ status: 'owner' });
    expect(boot.readAppConfig).toHaveBeenCalledWith({ kind: 'db' });
  });

  it('returns error, never owner, when the Firestore chunk fails to load', async () => {
    resetMarksForTest();
    boot.loadFirestoreBoot.mockRejectedValue(new Error('chunk failed'));
    await expect(checkAccess(OWNER)).resolves.toMatchObject({ status: 'error' });
    expect(boot.readAppConfig).not.toHaveBeenCalled();
    expect(performance.getEntriesByName('hf:owner')).toHaveLength(1);
  });

  it('returns error when the Firebase core fails to start', async () => {
    boot.getFirebase.mockRejectedValue(new Error('no config'));
    await expect(checkAccess(OWNER)).resolves.toMatchObject({ status: 'error' });
  });

  it('returns denied when the rules reject the read through the chunk', async () => {
    boot.readAppConfig.mockRejectedValue(
      Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      }),
    );
    await expect(checkAccess(OWNER)).resolves.toEqual({ status: 'denied' });
  });
});
