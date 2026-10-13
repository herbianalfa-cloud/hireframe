import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checkAccess, type Access } from '@/services/access';
import { prefetchToday } from '@/services/dashboard';
import { onAuthChange, signInWithGoogle, signOut, type AuthState } from '@/services/auth';

import { AppRoutes } from './App';
import { AuthGate } from './AuthGate';

vi.mock('@/services/auth', () => ({
  onAuthChange: vi.fn(),
  signInWithGoogle: vi.fn(),
  signOut: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/services/access', () => ({ checkAccess: vi.fn() }));
vi.mock('@/services/dashboard', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prefetchToday: vi.fn(() => () => undefined),
}));
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

function renderGate(path = '/') {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
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

describe('AuthGate Today prefetch (ADR-050)', () => {
  it('does not prefetch when signed out', async () => {
    givenAuth({ status: 'signed-out' });
    renderGate();
    await screen.findByRole('button', { name: /sign in/i });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prefetchToday).not.toHaveBeenCalled();
  });

  it('does not prefetch off the Today route', async () => {
    givenAuth({ status: 'signed-in', user });
    givenAccess({ status: 'owner' });
    renderGate('/jobs');
    await screen.findAllByRole('navigation');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prefetchToday).not.toHaveBeenCalled();
  });

  it('prefetches once on Today, before the owner check resolves, and stops on sign-out', async () => {
    const stop = vi.fn();
    vi.mocked(prefetchToday).mockReturnValue(stop);
    let resolveAccess: (access: Access) => void = () => undefined;
    vi.mocked(checkAccess).mockReturnValue(
      new Promise<Access>((resolve) => {
        resolveAccess = resolve;
      }),
    );
    let emit: (state: AuthState) => void = () => undefined;
    vi.mocked(onAuthChange).mockImplementation((callback) => {
      emit = callback;
      callback({ status: 'signed-in', user });
      return () => undefined;
    });
    renderGate();
    await waitFor(() => {
      expect(prefetchToday).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryAllByRole('navigation')).toHaveLength(0);
    resolveAccess({ status: 'owner' });
    await screen.findAllByRole('navigation');
    expect(prefetchToday).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    act(() => {
      emit({ status: 'signed-out' });
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('shows a non-owner No access and no data, though the prefetch started', async () => {
    givenAuth({ status: 'signed-in', user });
    givenAccess({ status: 'denied' });
    renderGate();
    await screen.findByText(/no access/i);
    expectNothingOfTheApp();
  });
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
