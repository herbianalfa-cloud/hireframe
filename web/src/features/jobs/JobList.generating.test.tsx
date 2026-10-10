import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { GENERATING_APPLIED_REASON } from '@/services/job-writes';

import { makeView, NOW } from './fixtures';
import { JobList } from './JobList';

// The real status write over a fake Firestore: only the document read and the batch are faked, so
// "nothing is written" is checked at the batch, not at a mocked service.
interface Store {
  application: Record<string, unknown> | null;
  batch: { update: Mock; set: Mock; commit: Mock };
}
const store = vi.hoisted<Store>(() => ({
  application: { stage: 'generating' },
  batch: { update: vi.fn(), set: vi.fn(), commit: vi.fn() },
}));

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  doc: (_db: unknown, path: string) => ({ path }),
  collection: (_db: unknown, path: string) => ({ path }),
  getDoc: () =>
    Promise.resolve({
      exists: () => store.application !== null,
      data: () => store.application ?? undefined,
    }),
  writeBatch: () => store.batch,
  serverTimestamp: () => 'server-time',
}));
vi.mock('@/services/firebase', () => ({ getFirebase: () => Promise.resolve({ db: {} }) }));

beforeEach(() => {
  store.application = { stage: 'generating' };
  store.batch.update.mockReset();
  store.batch.set.mockReset();
  store.batch.commit.mockReset().mockResolvedValue(undefined);
});

function setup() {
  const onCommitted = vi.fn();
  render(
    <JobList
      jobs={[makeView('a', { title: 'First role' })]}
      label="Test jobs"
      now={NOW}
      onOpen={vi.fn()}
      onCommitted={onCommitted}
    />,
  );
  return { onCommitted, row: () => document.querySelector<HTMLElement>('[data-job-row]') };
}

describe('the a key on a job whose CV is being written', () => {
  it('says why and writes nothing, not even the job', async () => {
    const { onCommitted, row } = setup();
    row()?.focus();
    await userEvent.keyboard('a');
    expect((await screen.findByRole('alert')).textContent).toContain(GENERATING_APPLIED_REASON);
    expect(store.batch.update).not.toHaveBeenCalled();
    expect(store.batch.set).not.toHaveBeenCalled();
    expect(store.batch.commit).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('writes the job and the application together once the CV is ready', async () => {
    store.application = { stage: 'ready' };
    const { onCommitted, row } = setup();
    row()?.focus();
    await userEvent.keyboard('a');
    await waitFor(() => {
      expect(onCommitted).toHaveBeenCalledTimes(1);
    });
    expect(store.batch.commit).toHaveBeenCalledTimes(1);
    // The job, and the application's mirror beside it.
    expect(store.batch.update).toHaveBeenCalledTimes(2);
    expect(store.batch.update.mock.calls[1]?.[1]).toMatchObject({
      stage: 'applied',
      stageBefore: 'ready',
    });
  });
});
