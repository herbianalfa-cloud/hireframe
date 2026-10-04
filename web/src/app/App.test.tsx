import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { AppRoutes } from './App';
import { SessionContext } from './session';

vi.mock('@/features/profile/ProfilePage', () => ({ ProfilePage: () => <h1>Profile screen</h1> }));
vi.mock('@/features/criteria/CriteriaPage', () => ({
  CriteriaPage: () => <h1>Criteria screen</h1>,
}));
vi.mock('@/features/today/TodayPage', () => ({ TodayPage: () => <h1>Today screen</h1> }));
vi.mock('@/features/jobs/JobsPage', () => ({ JobsPage: () => <h1>Jobs screen</h1> }));
vi.mock('@/features/system/SystemPage', () => ({ SystemPage: () => <h1>System screen</h1> }));

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

describe('AppRoutes', () => {
  it.each([
    ['/', 'Today screen'],
    ['/jobs', 'Jobs screen'],
    ['/profile', 'Profile screen'],
    ['/criteria', 'Criteria screen'],
    ['/system', 'System screen'],
  ])('routes %s to the built screen, not the placeholder', async (path, heading) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
  });

  it('has the toast live region on every screen, outside the app root', async () => {
    renderAt('/jobs');
    await screen.findByRole('heading', { name: 'Jobs screen' });
    expect(
      document.body.querySelector(':scope > [role="status"][data-toast-region]'),
    ).not.toBeNull();
  });

  it('keeps the empty state for screens not built yet', () => {
    renderAt('/lookup');
    expect(screen.getByText('Look up a job link')).toBeTruthy();
  });
});
