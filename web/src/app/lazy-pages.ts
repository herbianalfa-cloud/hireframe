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

/**
 * Starts the Today prefetch (ADR-050) and the Today chunk. The dashboard service is imported
 * dynamically: a static import would pull it, the Firestore query helpers and the job schemas
 * into the initial JS, which is over its gzip budget (check-bundle). The returned function
 * stops the listener, also when it is called before the import has finished.
 */
export function startTodayPrefetch(): () => void {
  let cancelled = false;
  let stop: (() => void) | undefined;
  void loadTodayPage().catch(() => undefined);
  import('@/services/dashboard').then(
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
