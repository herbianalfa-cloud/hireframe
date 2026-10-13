type TodayModule = typeof import('@/features/today/TodayPage');

let todayPage: Promise<TodayModule> | undefined;

/**
 * Loads the Today screen's chunk once. `lazy()` and the sign-in prefetch (ADR-050) both call
 * this, so there is one import promise and the chunk is fetched while the owner check runs.
 */
export function loadTodayPage(): Promise<TodayModule> {
  todayPage ??= import('@/features/today/TodayPage');
  return todayPage;
}
