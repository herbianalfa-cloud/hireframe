import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetMarksForTest } from '@/lib/perf';

/**
 * The Firebase core / Firestore split (ADR-066). Module state is per import, so each case
 * loads `./firebase` fresh against mocked SDKs and a mocked `./firestore-boot`.
 */
const calls: string[] = [];
const sdk = vi.hoisted(() => ({
  connectDb: vi.fn(),
  httpsCallable: vi.fn(),
  initializeAppCheck: vi.fn(),
}));

vi.mock('firebase/app', () => ({ initializeApp: () => ({ name: 'app' }) }));
vi.mock('firebase/app-check', () => ({
  initializeAppCheck: (...args: unknown[]) => {
    calls.push('appcheck');
    sdk.initializeAppCheck(...args);
    return {};
  },
  onTokenChanged: () => () => undefined,
  ReCaptchaEnterpriseProvider: vi.fn(),
}));
vi.mock('firebase/auth', () => ({
  getAuth: () => ({ kind: 'auth' }),
  connectAuthEmulator: vi.fn(),
}));
vi.mock('firebase/functions', () => ({
  getFunctions: () => ({ kind: 'functions' }),
  connectFunctionsEmulator: vi.fn(),
  httpsCallable: sdk.httpsCallable,
}));
vi.mock('firebase/storage', () => ({
  getStorage: () => ({ kind: 'storage' }),
  connectStorageEmulator: vi.fn(),
}));
/** Re-registered per case: a `vi.mock` factory result survives `vi.resetModules()`. */
function mockBoot(gate?: () => Promise<unknown>): void {
  vi.doMock('./firestore-boot', async () => {
    if (gate) await gate();
    return {
      connectDb: (...args: unknown[]) => {
        calls.push('connectDb');
        sdk.connectDb(...args);
        return { kind: 'db' };
      },
      readAppConfig: vi.fn(),
    };
  });
}

beforeEach(() => {
  vi.resetModules();
  calls.length = 0;
  mockBoot();
  sdk.connectDb.mockReset().mockReturnValue({ kind: 'db' });
  resetMarksForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const marks = () => performance.getEntriesByType('mark').map((m) => m.name);

describe('getFirebaseCore / getFirebase', () => {
  it('builds the core without importing firestore-boot', async () => {
    const { getFirebaseCore } = await import('./firebase');
    await expect(getFirebaseCore()).resolves.toMatchObject({ auth: { kind: 'auth' } });
    expect(sdk.connectDb).not.toHaveBeenCalled();
    expect(marks()).toContain('hf:firebase');
    expect(marks()).not.toContain('hf:firestore');
  });

  it('adds the db after the core with one import for concurrent calls', async () => {
    const { getFirebase } = await import('./firebase');
    const [a, b] = await Promise.all([getFirebase(), getFirebase()]);
    expect(a).toBe(b);
    expect(a.db).toEqual({ kind: 'db' });
    expect(sdk.connectDb).toHaveBeenCalledTimes(1);
    expect(sdk.connectDb).toHaveBeenCalledWith({ name: 'app' });
    expect(marks().indexOf('hf:firebase')).toBeLessThan(marks().indexOf('hf:firestore'));
  });

  it('initialises App Check before connecting Firestore when hosted', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_RECAPTCHA_SITE_KEY', 'site-key');
    vi.stubGlobal('window', { location: { host: 'hireframe.test' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              apiKey: 'k',
              appId: 'a',
              projectId: 'p',
              authDomain: 'p.firebaseapp.com',
            }),
        }),
      ),
    );
    const { getFirebase } = await import('./firebase');
    await getFirebase();
    expect(calls).toEqual(['appcheck', 'connectDb']);
  });

  it('rejects on a failed Firestore import, keeps the core, and imports again on the next call', async () => {
    mockBoot(() => Promise.reject(new Error('chunk failed')));
    const { getFirebase, getFirebaseCore } = await import('./firebase');
    const first = await getFirebaseCore();
    await expect(getFirebase()).rejects.toThrow();
    await expect(getFirebaseCore()).resolves.toBe(first);
  });
});

describe('Functions and Storage clients', () => {
  it('never wait for Firestore', async () => {
    mockBoot(() => new Promise(() => undefined)); // never settles
    const { getFirebase, getFunctionsClient, getStorageClient } = await import('./firebase');
    const pending = getFirebase();
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );

    await expect(getFunctionsClient()).resolves.toEqual({ kind: 'functions' });
    await expect(getStorageClient()).resolves.toMatchObject({ kind: 'storage' });
    expect(sdk.connectDb).not.toHaveBeenCalled();
    expect(settled).toBe(false);
  });

  it('let a callable reach httpsCallable while the Firestore import is pending', async () => {
    mockBoot(() => new Promise(() => undefined));
    sdk.httpsCallable.mockReturnValue(() => Promise.resolve({ data: { ok: true } }));
    const { getFirebase } = await import('./firebase');
    void getFirebase();
    const { callOwnerCallable } = await import('./callable');
    await callOwnerCallable('anything' as never, {}).catch(() => undefined);
    expect(sdk.httpsCallable).toHaveBeenCalled();
    expect(sdk.connectDb).not.toHaveBeenCalled();
  });
});
