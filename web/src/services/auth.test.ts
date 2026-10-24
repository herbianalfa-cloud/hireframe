import { beforeEach, describe, expect, it, vi } from 'vitest';

import { onAuthChange, signInErrorMessage, signInWithGoogle, signOut } from './auth';

const sdk = vi.hoisted(() => ({
  onAuthStateChanged: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
  getFirebase: vi.fn(),
}));

vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: class {
    setCustomParameters = vi.fn();
  },
  onAuthStateChanged: sdk.onAuthStateChanged,
  signInWithPopup: sdk.signInWithPopup,
  signInWithRedirect: vi.fn(),
  signOut: sdk.signOut,
}));
// `getFirebase` (the one that waits for Firestore) never settles: auth must not touch it.
vi.mock('./firebase', () => ({
  getFirebaseCore: () => Promise.resolve({ app: {}, auth: { kind: 'auth' } }),
  getFirebase: sdk.getFirebase,
}));

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  sdk.onAuthStateChanged.mockReset().mockReturnValue(() => undefined);
  sdk.signInWithPopup.mockReset().mockResolvedValue({});
  sdk.signOut.mockReset().mockResolvedValue(undefined);
  sdk.getFirebase.mockReset().mockReturnValue(new Promise(() => undefined));
});

describe('auth never waits for Firestore (ADR-066)', () => {
  it('onAuthChange listens as soon as the core is up', async () => {
    const stop = onAuthChange(() => undefined);
    await tick();
    expect(sdk.onAuthStateChanged).toHaveBeenCalledWith({ kind: 'auth' }, expect.any(Function));
    expect(sdk.getFirebase).not.toHaveBeenCalled();
    stop();
  });

  it('signInWithGoogle and signOut finish with Firestore still pending', async () => {
    await expect(signInWithGoogle()).resolves.toEqual({ ok: true });
    await expect(signOut()).resolves.toBeUndefined();
    expect(sdk.signInWithPopup).toHaveBeenCalledTimes(1);
    expect(sdk.signOut).toHaveBeenCalledWith({ kind: 'auth' });
    expect(sdk.getFirebase).not.toHaveBeenCalled();
  });
});

describe('signInErrorMessage', () => {
  it('explains closed sign-ups (User actions "create" disabled)', () => {
    expect(signInErrorMessage('auth/admin-restricted-operation')).toBe(
      'Sign-ups are closed. Hireframe is private.',
    );
  });

  it('stays quiet when the user closes the pop-up', () => {
    expect(signInErrorMessage('auth/popup-closed-by-user')).toBeNull();
    expect(signInErrorMessage('auth/cancelled-popup-request')).toBeNull();
  });

  it('falls back to a generic message', () => {
    expect(signInErrorMessage(undefined)).toBe('Sign-in failed. Try again.');
  });
});
