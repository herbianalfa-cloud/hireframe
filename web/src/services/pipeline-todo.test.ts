import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
/** `getFirebase` settles when the test says so; unset, it resolves at once. */
const firebase = vi.hoisted(() => ({ pending: undefined as Promise<unknown> | undefined }));
vi.mock('./firebase', () => ({
  getFirebase: () => firebase.pending ?? Promise.resolve({ db: {} }),
}));

function deferred(): {
  promise: Promise<unknown>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = () => {
      res({ db: {} });
    };
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// Evaluate the listener module (and the Firestore helpers it imports) once, so the cases below
// only wait for already-resolved promises: no wall-clock timeout decides a result.
beforeAll(async () => {
  await import('./pipeline-todo-listen');
});

beforeEach(() => {
  firebase.pending = undefined;
  state.unsubscribe.mockClear();
  state.listens.mockClear();
  state.constraints = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it('starts no listener when everything unsubscribed before Firebase was ready', async () => {
    const gate = deferred();
    firebase.pending = gate.promise;
    const stop = watchTodoCount(() => undefined);
    stop();
    gate.resolve();
    await gate.promise;
    await import('./pipeline-todo-listen'); // already evaluated: resolves after the start's own
    await tick();
    expect(state.listens).not.toHaveBeenCalled();
  });

  it('publishes an error once, logs it and does not retry when Firebase fails', async () => {
    const gate = deferred();
    firebase.pending = gate.promise;
    const seen: TodoCount[] = [];
    const stop = watchTodoCount((value) => seen.push(value));
    gate.reject(Object.assign(new Error('boom'), { code: 'unavailable' }));
    await tick();

    expect(seen).toEqual([{ status: 'loading' }, { status: 'error' }]);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('pipeline.todo_failed'));
    expect(state.listens).not.toHaveBeenCalled();
    stop();
  });

  it('publishes nothing when everything unsubscribed before Firebase failed', async () => {
    const gate = deferred();
    firebase.pending = gate.promise;
    const seen: TodoCount[] = [];
    const stop = watchTodoCount((value) => seen.push(value));
    stop();
    gate.reject(new Error('boom'));
    await tick();

    expect(seen).toEqual([{ status: 'loading' }]);
    expect(console.error).toHaveBeenCalledTimes(1); // still logged
    expect(state.listens).not.toHaveBeenCalled();
  });

  it('marks a count at the limit as capped', async () => {
    const seen: TodoCount[] = [];
    const stop = watchTodoCount((value) => seen.push(value));
    await tick();
    state.onNext?.({ size: 50 });
    expect(seen.at(-1)).toEqual({ status: 'ready', count: 50, capped: true });
    stop();
  });

  it('reports a failed read as an error without throwing, and stays in it', async () => {
    const seen: TodoCount[] = [];
    const stop = watchTodoCount((value) => seen.push(value));
    await tick();
    state.onError?.({ code: 'permission-denied' });
    expect(seen.at(-1)).toEqual({ status: 'error' });
    // A later subscriber is told the error at once, not "loading". There is no retry: a
    // Firestore listener that errored is over (parked in ROADMAP).
    const later: TodoCount[] = [];
    const stopLater = watchTodoCount((value) => later.push(value));
    expect(later).toEqual([{ status: 'error' }]);
    expect(state.listens).toHaveBeenCalledTimes(1);
    stopLater();
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

describe('watchTodoCount when the listener module fails to load', () => {
  afterEach(() => {
    vi.doUnmock('./pipeline-todo-listen');
  });

  it('publishes an error once, logs it, and does not import again', async () => {
    let imports = 0;
    vi.resetModules();
    vi.doMock('./pipeline-todo-listen', () => {
      imports += 1;
      throw new Error('chunk failed');
    });
    const { watchTodoCount: watchFresh } = await import('./pipeline-todo');
    const seen: TodoCount[] = [];
    const stop = watchFresh((value) => seen.push(value));
    await tick();

    expect(seen).toEqual([{ status: 'loading' }, { status: 'error' }]);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(imports).toBe(1);
    expect(state.listens).not.toHaveBeenCalled();
    // A later subscriber is told the error at once; nothing retries behind its back.
    const later: TodoCount[] = [];
    const stopLater = watchFresh((value) => later.push(value));
    await tick();
    expect(later).toEqual([{ status: 'error' }]);
    expect(imports).toBe(1);
    stopLater();
    stop();
  });
});
