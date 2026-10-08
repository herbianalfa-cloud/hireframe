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

/** Forgets what was marked, for tests that reload the page's state. */
export function resetMarksForTest(): void {
  marked.clear();
  try {
    performance.clearMarks();
  } catch {
    // Nothing to clear.
  }
}
