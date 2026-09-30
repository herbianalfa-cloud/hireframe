import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';

import { CriteriaPage } from '@/features/criteria/CriteriaPage';
import { ProfilePage } from '@/features/profile/ProfilePage';

import { AuthGate } from './AuthGate';
import { NAV_ITEMS } from './nav';
import { EmptyPage, MorePage, NotFoundPage } from './pages';
import { Shell } from './Shell';

/** Screens that are built; every other nav item shows its designed empty state. */
const PAGES: Readonly<Record<string, () => ReactNode>> = {
  '/profile': () => <ProfilePage />,
  '/criteria': () => <CriteriaPage />,
};

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        {NAV_ITEMS.map((item) => (
          <Route
            key={item.path}
            path={item.path}
            element={PAGES[item.path]?.() ?? <EmptyPage item={item} />}
          />
        ))}
        <Route path="/more" element={<MorePage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthGate>
          <AppRoutes />
        </AuthGate>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
