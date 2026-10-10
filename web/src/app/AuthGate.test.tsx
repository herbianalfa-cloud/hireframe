import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checkAccess, type Access } from '@/services/access';
import { onAuthChange, signInWithGoogle, signOut, type AuthState } from '@/services/auth';

import { AppRoutes } from './App';
import { AuthGate } from './AuthGate';

vi.mock('@/services/auth', () => ({
  onAuthChange: vi.fn(),
  signInWithGoogle: vi.fn(),
  signOut: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/services/access', () => ({ checkAccess: vi.fn() }));
// The shell's pipeline badge reads Firestore; this file is about the gate.
vi.mock('@/services/pipeline-todo', () => ({
  watchTodoCount: (
    callback: (state: { status: 'ready'; count: number; capped: boolean }) => void,
  ) => {
    callback({ status: 'ready', count: 0, capped: false });
    return () => undefined;
  },
}));

const user = { uid: 'uid-1', email: 'person@example.com' };

function givenAuth(state: AuthState) {
  vi.mocked(onAuthChange).mockImplementation((callback) => {
    callback(state);
    return () => undefined;
  });
}

function givenAccess(access: Access) {
  vi.mocked(checkAccess).mockResolvedValue(access);
}

function renderGate() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AuthGate>
          <AppRoutes />
        </AuthGate>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function expectNothingOfTheApp() {
  expect(screen.queryAllByRole('navigation')).toHaveLength(0);
  expect(screen.queryAllByRole('link')).toHaveLength(0);
  expect(screen.queryByRole('heading', { name: 'Today' })).toBeNull();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AuthGate', () => {
  it('shows only the sign-in screen when signed out', async () => {
    givenAuth({ status: 'signed-out' });
    renderGate();

    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeDefined();
    expectNothingOfTheApp();
    expect(checkAccess).not.toHaveBeenCalled();
  });

  it('shows "No access" and nothing else to a signed-in non-owner', async () => {
    givenAuth({ status: 'signed-in', user });
    givenAccess({ status: 'denied' });
    renderGate();

    expect(await screen.findByRole('heading', { name: 'No access' })).toBeDefined();
    expect(checkAccess).toHaveBeenCalledWith('uid-1');
    expectNothingOfTheApp();

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('shows an error state (not the app) when the access check fails', async () => {
    givenAuth({ status: 'signed-in', user });
    givenAccess({ status: 'error', message: "Couldn't check access. Try again." });
    renderGate();

    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeDefined();
    expect(screen.getByRole('alert').textContent).toBe("Couldn't check access. Try again.");
    expectNothingOfTheApp();
  });

  it('shows an error state when Firebase fails to start', async () => {
    givenAuth({ status: 'error', message: "Hireframe couldn't start. Reload to try again." });
    renderGate();

    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeDefined();
    expectNothingOfTheApp();
  });

  it('shows the shell to the owner', async () => {
    givenAuth({ status: 'signed-in', user });
    givenAccess({ status: 'owner' });
    renderGate();

    expect(await screen.findByRole('heading', { level: 1, name: 'Today' })).toBeDefined();
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    for (const label of ['Today', 'Jobs', 'Lookup', 'Profile', 'Criteria', 'System']) {
      expect(within(primary).getByRole('link', { name: label })).toBeDefined();
    }
  });

  it('explains closed sign-ups when a new account is rejected', async () => {
    givenAuth({ status: 'signed-out' });
    vi.mocked(signInWithGoogle).mockResolvedValue({
      ok: false,
      message: 'Sign-ups are closed. Hireframe is private.',
    });
    renderGate();

    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Sign-ups are closed. Hireframe is private.',
    );
    expectNothingOfTheApp();
  });
});
