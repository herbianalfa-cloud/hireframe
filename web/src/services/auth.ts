import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
} from 'firebase/auth';

import { markOnce } from '@/lib/perf';

import { getFirebase } from './firebase';
import { errorCode, logError } from './log';

export interface AuthUser {
  uid: string;
  email: string | null;
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: AuthUser }
  | { status: 'error'; message: string };

/** Subscribes to auth changes; returns an unsubscribe function. */
export function onAuthChange(callback: (state: AuthState) => void): () => void {
  let cancelled = false;
  let unsubscribe: (() => void) | undefined;

  getFirebase().then(
    ({ auth }) => {
      if (cancelled) return;
      unsubscribe = onAuthStateChanged(auth, (user) => {
        markOnce('hf:auth');
        callback(
          user
            ? { status: 'signed-in', user: { uid: user.uid, email: user.email } }
            : { status: 'signed-out' },
        );
      });
    },
    (error: unknown) => {
      logError('auth.init_failed', { code: errorCode(error) ?? 'unknown' });
      if (!cancelled)
        callback({ status: 'error', message: "Hireframe couldn't start. Reload to try again." });
    },
  );

  return () => {
    cancelled = true;
    unsubscribe?.();
  };
}

/**
 * User-facing message for a failed sign-in, or null when there is nothing to say
 * (the user closed the pop-up).
 */
export function signInErrorMessage(code: string | undefined): string | null {
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return null;
    case 'auth/admin-restricted-operation':
      return 'Sign-ups are closed. Hireframe is private.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.';
    default:
      return 'Sign-in failed. Try again.';
  }
}

export type SignInResult = { ok: true } | { ok: false; message: string | null };

export async function signInWithGoogle(): Promise<SignInResult> {
  const { auth } = await getFirebase();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
    return { ok: true };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'auth/popup-blocked') {
      await signInWithRedirect(auth, provider); // navigates away
      return { ok: true };
    }
    logError('auth.sign_in_failed', { code: code ?? 'unknown' });
    return { ok: false, message: signInErrorMessage(code) };
  }
}

export async function signOut(): Promise<void> {
  const { auth } = await getFirebase();
  await firebaseSignOut(auth);
}
