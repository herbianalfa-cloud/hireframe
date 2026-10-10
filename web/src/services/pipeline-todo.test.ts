import { beforeEach, describe, expect, it, vi } from 'vitest';

import { watchTodoCount, type TodoCount } from './pipeline-todo';

type Snapshot = (snapshot: { size: number }) => void;

const state = {
  onNext: undefined as Snapshot | undefined,
  onError: undefined as ((error: { code: string }) => void) | undefined,
  unsubscribe: vi.fn(),
  listens: vi.fn(),
  constraints: [] as unknown[],
};

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  collection: (_db: unknown, path: string) => ({ path }),
  query: (source: unknown, ...constraints: unknown[]) => {
    state.constraints = constraints;
    return source;
  },
  limit: (n: number) => ({ type: 'limit', n }),
  onSnapshot: (_q: unknown, next: Snapshot, error: (e: { code: string }) => void) => {
    state.listens();
    state.onNext = next;
    state.onError = error;
    return state.unsubscribe;
  },
}));
vi.mock('./firebase', () => ({ getFirebase: () => Promise.resolve({ db: {} }) }));

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  state.unsubscribe.mockClear();
  state.listens.mockClear();
  state.constraints = [];
});

describe('watchTodoCount', () => {
  it('shares one limited listener between subscribers and stops it with the last', async () => {
    const first: TodoCount[] = [];
    const second: TodoCount[] = [];
    const stopFirst = watchTodoCount((value) => first.push(value));
    await tick();
    const stopSecond = watchTodoCount((value) => second.push(value));
    await tick();

    expect(state.listens).toHaveBeenCalledTimes(1);
    // One where(stage in …) and one limit: nothing unbounded, no orderBy.
    expect(state.constraints).toHaveLength(2);
    expect(state.constraints.at(-1)).toEqual({ type: 'limit', n: 50 });

    state.onNext?.({ size: 4 });
    expect(first.at(-1)).toEqual({ status: 'ready', count: 4, capped: false });
    expect(second.at(-1)).toEqual({ status: 'ready', count: 4, capped: false });

    stopFirst();
    expect(state.unsubscribe).not.toHaveBeenCalled();
    stopSecond();
    expect(state.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('marks a count at the limit as capped', async () => {
    const seen: TodoCount[] = [];
    const stop = watchTodoCount((value) => seen.push(value));
    await tick();
    state.onNext?.({ size: 50 });
    expect(seen.at(-1)).toEqual({ status: 'ready', count: 50, capped: true });
    stop();
  });

  it('reports a failed read as an error without throwing, and recovers on the next snapshot', async () => {
    const seen: TodoCount[] = [];
    const stop = watchTodoCount((value) => seen.push(value));
    await tick();
    state.onError?.({ code: 'permission-denied' });
    expect(seen.at(-1)).toEqual({ status: 'error' });
    state.onNext?.({ size: 1 });
    expect(seen.at(-1)).toEqual({ status: 'ready', count: 1, capped: false });
    stop();
  });

  it('starts again from loading after everything unsubscribed', async () => {
    const stop = watchTodoCount(() => undefined);
    await tick();
    state.onNext?.({ size: 2 });
    stop();
    const seen: TodoCount[] = [];
    const stopAgain = watchTodoCount((value) => seen.push(value));
    expect(seen[0]).toEqual({ status: 'loading' });
    stopAgain();
  });
});
