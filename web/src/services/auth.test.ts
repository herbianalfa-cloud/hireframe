import { describe, expect, it } from 'vitest';

import { signInErrorMessage } from './auth';

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
