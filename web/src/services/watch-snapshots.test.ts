import { Timestamp } from 'firebase/firestore';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { watchApplication, watchStage, type ApplicationView } from './applications';
import { watchCvHeader, type CvHeaderView } from './profile';
import type { LiveState } from './profile';

/**
 * The snapshot-parsing rules of the three live reads that can see the owner's own pending writes
 * (the Applied mirror, the CV header form): an invalid document is the error state, and the
 * local copy of a pending write, whose server timestamps are still null, is read with
 * `serverTimestamps: 'estimate'` and parses without an error or a log line.
 */

interface DataOptions {
  serverTimestamps?: 'estimate' | 'previous' | 'none';
}

interface FakeDoc {
  id: string;
  /** What the document holds; a `pending` field is null until the server answers. */
  data: Record<string, unknown>;
  pendingFields?: string[];
}

function snapshotDoc({ id, data, pendingFields = [] }: FakeDoc) {
  return {
    id,
    exists: () => true,
    data: (options?: DataOptions) => {
      const out: Record<string, unknown> = { ...data };
      for (const field of pendingFields) {
        out[field] = options?.serverTimestamps === 'estimate' ? data[field] : null;
      }
      return out;
    },
  };
}

const live = {
  next: undefined as ((snapshot: unknown) => void) | undefined,
};

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  collection: (_db: unknown, path: string) => ({ path }),
  doc: (_db: unknown, path: string) => ({ path }),
  query: (source: unknown) => source,
  limit: (n: number) => ({ type: 'limit', n }),
  where: () => ({}),
  orderBy: () => ({}),
  onSnapshot: (_q: unknown, next: (snapshot: unknown) => void) => {
    live.next = next;
    return () => undefined;
  },
}));
vi.mock('./firebase', () => ({ getFirebase: () => Promise.resolve({ db: {} }) }));

const at = Timestamp.fromDate(new Date('2026-10-05T08:00:00Z'));

const application = (overrides: Record<string, unknown> = {}) => ({
  jobId: 'job1',
  job: { title: 'Data Analyst', company: 'Northwind Analytics', verdict: 'apply' },
  stage: 'applied',
  stageBefore: 'ready',
  stageAt: at,
  startedAt: at,
  updatedAt: at,
  questions: [],
  attempt: 0,
  cvIds: [],
  schemaVersion: 1,
  ...overrides,
});

const header = (overrides: Record<string, unknown> = {}) => ({
  name: 'Alex Example',
  email: 'alex@example.com',
  createdAt: at,
  updatedAt: at,
  schemaVersion: 1,
  ...overrides,
});

function dataOf(seen: LiveState<ApplicationView[]>[]): ApplicationView[] {
  const last = seen.at(-1);
  return last?.status === 'ready' ? last.data : [];
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
let errors: MockInstance<typeof console.error>;

beforeEach(() => {
  live.next = undefined;
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  errors.mockRestore();
});

describe('watchApplication', () => {
  it('turns an invalid document into the error state, and logs it', async () => {
    const seen: LiveState<unknown>[] = [];
    const stop = watchApplication('job1', (state) => seen.push(state));
    await tick();
    live.next?.(snapshotDoc({ id: 'job1', data: application({ stage: 'nonsense' }) }));
    expect(seen.at(-1)).toMatchObject({ status: 'error' });
    expect(errors).toHaveBeenCalledTimes(1);
    stop();
  });

  it('parses the local copy of a pending write, with no error and no log', async () => {
    const seen: LiveState<unknown>[] = [];
    const stop = watchApplication('job1', (state) => seen.push(state));
    await tick();
    // The mirror just wrote updatedAt = serverTimestamp(); until the server answers it is null.
    live.next?.(snapshotDoc({ id: 'job1', data: application(), pendingFields: ['updatedAt'] }));
    expect(seen.at(-1)).toMatchObject({ status: 'ready', data: { stage: 'applied' } });
    expect(errors).not.toHaveBeenCalled();
    stop();
  });
});

describe('watchStage', () => {
  it('counts an invalid document and still lists the valid ones', async () => {
    const seen: LiveState<ApplicationView[]>[] = [];
    const stop = watchStage('applied', (state) => seen.push(state));
    await tick();
    live.next?.({
      docs: [
        snapshotDoc({ id: 'bad', data: application({ attempt: -4 }) }),
        snapshotDoc({ id: 'job1', data: application() }),
      ],
    });
    expect(seen.at(-1)).toMatchObject({ status: 'ready', invalid: 1 });
    expect(dataOf(seen)).toHaveLength(1);
    expect(errors).toHaveBeenCalledTimes(1);
    stop();
  });

  it('parses the local copy of a pending write, with no error and no log', async () => {
    const seen: LiveState<ApplicationView[]>[] = [];
    const stop = watchStage('applied', (state) => seen.push(state));
    await tick();
    live.next?.({
      docs: [snapshotDoc({ id: 'job1', data: application(), pendingFields: ['updatedAt'] })],
    });
    expect(seen.at(-1)).toMatchObject({ status: 'ready', invalid: 0 });
    expect(dataOf(seen)).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
    stop();
  });
});

describe('watchCvHeader', () => {
  it('returns an invalid header as header: null, flagged as invalid, and logs it', async () => {
    const seen: LiveState<CvHeaderView | null>[] = [];
    const stop = watchCvHeader((state) => seen.push(state));
    await tick();
    live.next?.(snapshotDoc({ id: 'cvHeader', data: header({ email: 'not-an-email' }) }));
    expect(seen.at(-1)).toMatchObject({
      status: 'ready',
      invalid: 1,
      data: { header: null },
    });
    expect(errors).toHaveBeenCalledTimes(1);
    stop();
  });

  it('parses the local copy of a pending save, with no error and no log', async () => {
    const seen: LiveState<CvHeaderView | null>[] = [];
    const stop = watchCvHeader((state) => seen.push(state));
    await tick();
    live.next?.(snapshotDoc({ id: 'cvHeader', data: header(), pendingFields: ['updatedAt'] }));
    expect(seen.at(-1)).toMatchObject({
      status: 'ready',
      invalid: 0,
      data: { header: { name: 'Alex Example' } },
    });
    expect(errors).not.toHaveBeenCalled();
    stop();
  });
});
