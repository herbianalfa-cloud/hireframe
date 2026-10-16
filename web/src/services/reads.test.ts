import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Next = (snapshot: unknown) => void;
const captured: { next?: Next } = {};

vi.mock('firebase/firestore', () => ({
  onSnapshot: (_ref: unknown, next: Next) => {
    captured.next = next;
    return () => undefined;
  },
}));

const docs = (n: number) => Array.from({ length: n }, () => ({}));
const delivery = (total: number, changed: number) => ({
  docs: docs(total),
  docChanges: () => docs(changed),
  metadata: { fromCache: false },
});

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DEV', true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('watchSnapshot (C5 wiring)', () => {
  it('bills the first delivery by documents and later ones by changes, and passes snapshots on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { watchSnapshot } = await import('./reads');
    const seen: unknown[] = [];
    watchSnapshot({ path: 'jobs' } as never, (snapshot) => seen.push(snapshot));

    const first = delivery(199, 199);
    captured.next?.(first); // 199 reads
    captured.next?.(delivery(199, 1)); // +1 = 200: no warning
    expect(warn).not.toHaveBeenCalled();
    captured.next?.(delivery(199, 1)); // +1 = 201: warns (not 199 more, as a docs count would)
    expect(warn).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(first);
  });

  it('counts nothing and never touches the console outside dev', async () => {
    vi.stubEnv('DEV', false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { watchSnapshot, tally } = await import('./reads');
    watchSnapshot({ path: 'jobs' } as never, () => undefined);
    captured.next?.(delivery(5_000, 5_000));
    await tally(Promise.resolve(delivery(5_000, 5_000)), 'x');
    expect(warn).not.toHaveBeenCalled();
  });

  it('tally returns the answer unchanged and counts its documents in dev', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { tally } = await import('./reads');
    const answer = delivery(201, 201);
    await expect(tally(Promise.resolve(answer), 'jobs:getDocs')).resolves.toBe(answer);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
