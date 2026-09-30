import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { AppRoutes } from './App';
import { SessionContext } from './session';

vi.mock('@/features/profile/ProfilePage', () => ({ ProfilePage: () => <h1>Profile screen</h1> }));
vi.mock('@/features/criteria/CriteriaPage', () => ({
  CriteriaPage: () => <h1>Criteria screen</h1>,
}));

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
    ['/profile', 'Profile screen'],
    ['/criteria', 'Criteria screen'],
  ])('routes %s to the built screen, not the placeholder', (path, heading) => {
    renderAt(path);
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
  });

  it('keeps the empty state for screens not built yet', () => {
    renderAt('/jobs');
    expect(screen.getByText('No jobs yet')).toBeTruthy();
  });
});
