/**
 * Dev-only Firestore read counter (m8c-plan C5, billing-guards §6). A React effect or listener bug
 * can loop reads from the browser; in dev this warns in the console above 200 document reads in
 * a minute. Production builds carry none of it: every entry point is behind
 * `import.meta.env.DEV`, which Vite replaces with `false`, and `check:bundle` greps `web/dist`
 * for the warning text.
 */

export const READ_LIMIT_PER_MINUTE = 200;
export const READ_WINDOW_MS = 60_000;
export const READ_WARNING = 'Firestore reads above 200 a minute (dev only)';

export interface ReadCounter {
  /** Records `count` document reads for `label`; warns when the minute's total passes the limit. */
  add(count: number, label: string): void;
  /** Reads recorded in the last minute. */
  total(): number;
}

export function createReadCounter(deps: {
  now: () => number;
  warn: (message: string) => void;
}): ReadCounter {
  let events: { at: number; count: number; label: string }[] = [];
  let warned = false;

  function prune(): number {
    const from = deps.now() - READ_WINDOW_MS;
    events = events.filter((event) => event.at > from);
    return events.reduce((sum, event) => sum + event.count, 0);
  }

  return {
    add(count, label) {
      // The window has drained below the limit since the last warning: a new crossing may warn.
      if (prune() <= READ_LIMIT_PER_MINUTE) warned = false;
      events.push({ at: deps.now(), count, label });
      const total = prune();
      if (total <= READ_LIMIT_PER_MINUTE) return;
      // Once per crossing: a loop would otherwise print on every read.
      if (warned) return;
      warned = true;
      const byLabel = new Map<string, number>();
      for (const event of events)
        byLabel.set(event.label, (byLabel.get(event.label) ?? 0) + event.count);
      const top = [...byLabel.entries()].sort((a, b) => b[1] - a[1])[0];
      deps.warn(
        `${READ_WARNING}: ${String(total)} in the last minute` +
          (top ? `, most from ${top[0]} (${String(top[1])})` : ''),
      );
    },
    total: prune,
  };
}

let devCounter: ReadCounter | undefined;

/** Records reads on the page's counter. Does nothing outside dev. */
export function recordReads(count: number, label: string): void {
  if (!import.meta.env.DEV) return;
  devCounter ??= createReadCounter({
    now: () => Date.now(),
    warn: (message) => {
      console.warn(message);
    },
  });
  devCounter.add(count, label);
}

interface DocsSnapshot {
  docs: readonly unknown[];
  docChanges(): readonly unknown[];
}

function isDocsSnapshot(value: unknown): value is DocsSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    'docs' in value &&
    Array.isArray(value.docs) &&
    'docChanges' in value &&
    typeof value.docChanges === 'function'
  );
}

/**
 * Reads billed by one delivery of a listener (Firestore bills the whole result once, then only
 * the changed documents): `docs.length` (min 1) for the first, `docChanges().length` (min 1) after.
 * A single-document listener is 1 either way.
 */
export function listenerReads(
  label: string,
  record: (count: number, label: string) => void = recordReads,
): (snapshot: unknown) => void {
  let first = true;
  return (snapshot) => {
    if (!import.meta.env.DEV) return;
    const initial = first;
    first = false;
    if (!isDocsSnapshot(snapshot)) {
      record(1, label);
      return;
    }
    record(Math.max(1, initial ? snapshot.docs.length : snapshot.docChanges().length), label);
  };
}

/** Reads billed by a `getDoc` / `getDocs` / `getCountFromServer` answer: its documents, min 1. */
export function getReads(
  snapshot: unknown,
  label: string,
  record: (count: number, label: string) => void = recordReads,
): void {
  if (!import.meta.env.DEV) return;
  record(isDocsSnapshot(snapshot) ? Math.max(1, snapshot.docs.length) : 1, label);
}
