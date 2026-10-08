import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { AppRoutes } from './App';
import appSource from './App.tsx?raw';
import { SessionContext } from './session';

vi.mock('@/features/profile/ProfilePage', () => ({ ProfilePage: () => <h1>Profile screen</h1> }));
vi.mock('@/features/criteria/CriteriaPage', () => ({
  CriteriaPage: () => <h1>Criteria screen</h1>,
}));
vi.mock('@/features/today/TodayPage', () => ({ TodayPage: () => <h1>Today screen</h1> }));
vi.mock('@/features/jobs/JobsPage', () => ({ JobsPage: () => <h1>Jobs screen</h1> }));
vi.mock('@/features/lookup/LookupPage', () => ({ LookupPage: () => <h1>Lookup screen</h1> }));
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
    ['/lookup', 'Lookup screen'],
    ['/profile', 'Profile screen'],
    ['/criteria', 'Criteria screen'],
    ['/system', 'System screen'],
  ])('routes %s to the built screen, not the placeholder', async (path, heading) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
  });

  it('loads the Lookup screen lazily, so none of its code is in the initial bundle', () => {
    expect(appSource).toMatch(
      /const LookupPage = lazy\(\(\) =>\s+import\('@\/features\/lookup\/LookupPage'\)/,
    );
    expect(appSource).not.toMatch(/^import .* from '@\/features\/lookup/m);
  });
});
