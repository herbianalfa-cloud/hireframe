import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppRoutes } from './App';
import { SessionContext } from './session';

// The Jobs chunk fails to load, as a chunk that no longer exists after a deploy would.
vi.mock('@/features/jobs/JobsPage', () => {
  throw new Error('Failed to fetch dynamically imported module');
});
vi.mock('@/features/profile/ProfilePage', () => ({ ProfilePage: () => <h1>Profile screen</h1> }));

afterEach(() => {
  vi.restoreAllMocks();
});

function renderAt(path: string) {
  render(
    <SessionContext.Provider
      value={{ user: { uid: 'owner', email: 'owner@example.com' }, signOut: vi.fn() }}
    >
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}

describe('AppRoutes when a screen chunk fails', () => {
  it('shows a message and a Reload button instead of a blank app, and keeps the navigation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    renderAt('/jobs');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("This screen didn't load");
    expect(screen.getAllByRole('link', { name: /profile/i }).length).toBeGreaterThan(0);
    expect(reload).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('clears the message when the owner moves to another screen', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderAt('/jobs');
    await screen.findByRole('alert');

    const profileLink = screen.getAllByRole('link', { name: /profile/i }).at(0);
    if (profileLink === undefined) throw new Error('no Profile link in the navigation');
    await userEvent.click(profileLink);

    expect(await screen.findByRole('heading', { name: 'Profile screen' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
