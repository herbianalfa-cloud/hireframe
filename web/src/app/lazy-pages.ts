/**
 * Imports once, and forgets a failed import so the next call tries again. A rejected import
 * promise that stayed cached would fail every later caller until a full reload (ADR-066).
 */
export function retryableOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

const importToday = () => import('@/features/today/TodayPage');

let todayModule: Awaited<ReturnType<typeof importToday>> | undefined;

const loadToday = retryableOnce(() =>
  importToday().then((module) => {
    todayModule = module;
    return module;
  }),
);

/**
 * Loads the Today screen's chunk once. `lazy()` and the sign-in prefetch (ADR-050) both call
 * this, so there is one import promise and the chunk is fetched while the owner check runs.
 */
export function loadTodayPage(): ReturnType<typeof importToday> {
  return loadToday();
}

/**
 * The Today module once its chunk has loaded, else undefined. `lazy()` always suspends on its
 * first render, and React holds the reveal for 300 ms after a fallback was shown, so Today
 * renders this component directly when it is already here (ADR-061).
 */
export function loadedTodayPage(): Awaited<ReturnType<typeof importToday>> | undefined {
  return todayModule;
}

const importDashboard = () => import('@/services/dashboard');

const loadDashboard = retryableOnce(importDashboard);

/**
 * Loads the dashboard service's chunk once. The app starts this when it lands on `/`, once the
 * Firebase core is ready (ADR-066) and before the signed-in user is known, so the chunk is
 * already in when the uid arrives and the listener starts without waiting for it (ADR-050). It
 * stays a dynamic import: a static one pulls the service, the Firestore query helpers and the
 * job schemas into the initial JS.
 */
export function loadDashboardService(): ReturnType<typeof importDashboard> {
  return loadDashboard();
}

/**
 * Starts the Today prefetch (ADR-050) and the Today chunk. The dashboard service is imported
 * dynamically (`loadDashboardService`, already under way once the core was ready when the app landed on `/`). The
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
