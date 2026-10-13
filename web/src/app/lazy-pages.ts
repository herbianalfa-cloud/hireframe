const importToday = () => import('@/features/today/TodayPage');

let todayPage: ReturnType<typeof importToday> | undefined;

/**
 * Loads the Today screen's chunk once. `lazy()` and the sign-in prefetch (ADR-050) both call
 * this, so there is one import promise and the chunk is fetched while the owner check runs.
 */
export function loadTodayPage(): ReturnType<typeof importToday> {
  todayPage ??= importToday();
  return todayPage;
}

const importDashboard = () => import('@/services/dashboard');

let dashboardService: ReturnType<typeof importDashboard> | undefined;

/**
 * Loads the dashboard service's chunk once. The app starts this on load when it lands on `/`,
 * before the signed-in user is known, so the chunk is already in when the uid arrives and the
 * listener starts without waiting for it (ADR-050). It stays a dynamic import: a static one
 * pulls the service, the Firestore query helpers and the job schemas into the initial JS.
 */
export function loadDashboardService(): ReturnType<typeof importDashboard> {
  dashboardService ??= importDashboard();
  return dashboardService;
}

/**
 * Starts the Today prefetch (ADR-050) and the Today chunk. The dashboard service is imported
 * dynamically (`loadDashboardService`, already under way when the app landed on `/`). The
 * returned function stops the listener, also when it is called before the import has finished.
 */
export function startTodayPrefetch(): () => void {
  let cancelled = false;
  let stop: (() => void) | undefined;
  void loadTodayPage().catch(() => undefined);
  loadDashboardService().then(
    (dashboard) => {
      if (!cancelled) stop = dashboard.prefetchToday();
    },
    () => undefined,
  );
  return () => {
    cancelled = true;
    stop?.();
  };
}
