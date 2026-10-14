import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';

import { Skeleton } from '@/components/ui/skeleton';

import { AuthGate } from './AuthGate';
import { loadedTodayPage, loadTodayPage } from './lazy-pages';
import { NAV_ITEMS } from './nav';
import { EmptyPage, MorePage, NotFoundPage } from './pages';
import { Shell } from './Shell';

// Screens load on first visit (ADR-021), so the shell stays small.
const LazyTodayPage = lazy(() => loadTodayPage().then((module) => ({ default: module.TodayPage })));

/**
 * Today renders its component directly when the chunk is already loaded (the sign-in prefetch
 * starts it, ADR-050). A `lazy()` component suspends even then, and React throttles the reveal
 * after a fallback by 300 ms (ADR-061). The choice is made once per mount, so it never remounts.
 */
function TodayPage() {
  const [Page] = useState(() => loadedTodayPage()?.TodayPage ?? LazyTodayPage);
  return <Page />;
}

const JobsPage = lazy(() =>
  import('@/features/jobs/JobsPage').then((module) => ({ default: module.JobsPage })),
);
const PipelinePage = lazy(() =>
  import('@/features/pipeline/PipelinePage').then((module) => ({ default: module.PipelinePage })),
);
const LookupPage = lazy(() =>
  import('@/features/lookup/LookupPage').then((module) => ({ default: module.LookupPage })),
);
const ProfilePage = lazy(() =>
  import('@/features/profile/ProfilePage').then((module) => ({ default: module.ProfilePage })),
);
const CriteriaPage = lazy(() =>
  import('@/features/criteria/CriteriaPage').then((module) => ({ default: module.CriteriaPage })),
);
const SystemPage = lazy(() =>
  import('@/features/system/SystemPage').then((module) => ({ default: module.SystemPage })),
);

function ScreenLoading() {
  return (
    <div role="status" aria-label="Loading screen" className="space-y-3">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32" />
    </div>
  );
}

const screen = (page: ReactNode) => () => <Suspense fallback={<ScreenLoading />}>{page}</Suspense>;

/** Screens that are built; every other nav item shows its designed empty state. */
const PAGES: Readonly<Record<string, () => ReactNode>> = {
  '/': screen(<TodayPage />),
  '/jobs': screen(<JobsPage />),
  '/pipeline': screen(<PipelinePage />),
  '/lookup': screen(<LookupPage />),
  '/profile': screen(<ProfilePage />),
  '/criteria': screen(<CriteriaPage />),
  '/system': screen(<SystemPage />),
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
