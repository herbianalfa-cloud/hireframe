/**
 * Per-step timing marks for the Today load (`hf:*`, ADR-038). A convenience only: every call is
 * wrapped so a missing or failing Performance API never affects the app. Marks carry scalars
 * only (counts, flags, sizes), never job text.
 */
export type MarkDetail = Record<string, string | number | boolean>;

const marked = new Set<string>();

/**
 * Marks `name` the first time it is called in this page load; later calls do nothing. `detail`
 * may be a function so a costly detail (a size) is computed only for the mark that is kept.
 */
export function markOnce(name: string, detail?: MarkDetail | (() => MarkDetail)): void {
  if (marked.has(name)) return;
  marked.add(name);
  try {
    const resolved = typeof detail === 'function' ? detail() : detail;
    performance.mark(name, resolved ? { detail: resolved } : undefined);
  } catch {
    // Marking is a convenience; the app works without it.
  }
}

/**
 * Every `hf:*` mark as `[name, ms]`, in time order (for the console and tests). `hf:usable` is a
 * measure from 0, so its time is its end.
 */
export function hfMarks(): [string, number][] {
  try {
    return performance
      .getEntries()
      .filter((entry) => entry.name.startsWith('hf:'))
      .map((entry): [string, number] => [entry.name, entry.startTime + entry.duration])
      .sort((a, b) => a[1] - b[1])
      .map(([name, ms]): [string, number] => [name, Math.round(ms)]);
  } catch {
    return [];
  }
}

// ---- When the app is usable (M7 7D.4) ----

/** On a route that isn't Today, the first idle moment counts; this is its fallback. */
const IDLE_FALLBACK_MS = 1_500;
/** If Today never becomes usable (its list failed), later reads still start after this. */
const USABLE_GIVE_UP_MS = 10_000;

let usableSignalled = false;
const usableWaiters = new Set<() => void>();

/** Today calls this when it marks `hf:usable`; whatever was waiting on it may now start. */
export function signalUsable(): void {
  usableSignalled = true;
  for (const wake of [...usableWaiters]) wake();
}

/**
 * Resolves when reads that aren't on the critical path may start (the pipeline badge). On Today
 * (`onToday`) that is when `signalUsable` is called; anywhere else, at the first idle moment
 * (`requestIdleCallback`, else 1.5 s). Both fall back to a time limit, so a failed Apply list can't
 * hold them back for good.
 */
export function whenUsable(onToday: boolean): Promise<void> {
  if (usableSignalled) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let idle: number | undefined;
    const done = () => {
      usableWaiters.delete(done);
      timers.forEach(clearTimeout);
      if (idle !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
      resolve();
    };
    usableWaiters.add(done);
    timers.push(setTimeout(done, USABLE_GIVE_UP_MS));
    if (!onToday) {
      if (typeof requestIdleCallback === 'function') {
        idle = requestIdleCallback(done, { timeout: IDLE_FALLBACK_MS });
      } else {
        timers.push(setTimeout(done, IDLE_FALLBACK_MS));
      }
    }
  });
}

/** Forgets what was marked, for tests that reload the page's state. */
export function resetMarksForTest(): void {
  marked.clear();
  usableSignalled = false;
  usableWaiters.clear();
  try {
    performance.clearMarks();
  } catch {
    // Nothing to clear.
  }
}
