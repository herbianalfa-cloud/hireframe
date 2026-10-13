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
