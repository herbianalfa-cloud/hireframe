import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';

import { AuthGate } from './AuthGate';
import { NAV_ITEMS } from './nav';
import { EmptyPage, MorePage, NotFoundPage } from './pages';
import { Shell } from './Shell';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        {NAV_ITEMS.map((item) => (
          <Route key={item.path} path={item.path} element={<EmptyPage item={item} />} />
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
