import type { DocumentData } from 'firebase/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GENERATING_APPLIED_REASON } from './job-writes';
import { setJobStatus } from './jobs';

/**
 * setJobStatus and the Applied mirror (M7 7D.4): one `getDoc` of the application before the
 * batch, then the job, its event and the mirror in a single commit through the services.
 */

const batch = {
  update: vi.fn(),
  set: vi.fn(),
  commit: vi.fn(() => Promise.resolve()),
};
const getDoc = vi.fn();

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDoc: (...args: unknown[]) => getDoc(...args) as unknown,
  writeBatch: () => batch,
  doc: (first: { path?: string }, path?: string) => ({ path: path ?? `${first.path ?? ''}/new` }),
  collection: (_db: unknown, path: string) => ({ path }),
  serverTimestamp: () => 'SERVER_TIME',
}));
vi.mock('./firebase', () => ({ getFirebase: () => Promise.resolve({ db: {} }) }));

const view = (status: string, extra: DocumentData = {}) =>
  ({
    id: 'job-1',
    job: { status },
    raw: { status, verdict: 'apply', ...extra },
  }) as unknown as Parameters<typeof setJobStatus>[0];

function application(data: DocumentData | null) {
  getDoc.mockResolvedValue({ exists: () => data !== null, data: () => data });
}

beforeEach(() => {
  batch.update.mockClear();
  batch.set.mockClear();
  batch.commit.mockClear();
  getDoc.mockReset();
});

const updates = () => batch.update.mock.calls.map(([ref, data]) => [ref.path, data]);

describe('setJobStatus with an application', () => {
  it('reads the application once, then commits the job, event and mirror in one batch', async () => {
    application({ stage: 'needs_input' });
    await setJobStatus(view('new'), 'applied');
    expect(getDoc).toHaveBeenCalledTimes(1);
    expect(getDoc.mock.calls[0]?.[0]).toEqual({ path: 'applications/job-1' });
    expect(batch.commit).toHaveBeenCalledTimes(1);
    expect(updates()).toEqual([
      [
        'jobs/job-1',
        expect.objectContaining({ status: 'applied', appliedAt: 'SERVER_TIME' }) as unknown,
      ],
      [
        'applications/job-1',
        { stage: 'applied', stageBefore: 'needs_input', updatedAt: 'SERVER_TIME' },
      ],
    ]);
    expect(batch.set).toHaveBeenCalledTimes(1);
  });

  it('restores stageBefore on undo', async () => {
    application({ stage: 'applied', stageBefore: 'ready' });
    await setJobStatus(view('applied', { appliedAt: 'x' }), 'new');
    const mirror = updates().find(([path]) => path === 'applications/job-1');
    expect(mirror?.[1]).toMatchObject({ stage: 'ready', updatedAt: 'SERVER_TIME' });
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it('writes only the job and its event when there is no application', async () => {
    application(null);
    await setJobStatus(view('new'), 'applied');
    expect(updates().map(([path]) => path)).toEqual(['jobs/job-1']);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the CV is generating, and says why', async () => {
    application({ stage: 'generating' });
    await expect(setJobStatus(view('new'), 'applied')).rejects.toThrow(GENERATING_APPLIED_REASON);
    expect(batch.commit).not.toHaveBeenCalled();
  });

  it('fails the action, writing nothing, when the application cannot be read', async () => {
    getDoc.mockRejectedValue(Object.assign(new Error('offline'), { code: 'permission-denied' }));
    await expect(setJobStatus(view('new'), 'applied')).rejects.toThrow('offline');
    expect(batch.commit).not.toHaveBeenCalled();
  });

  it('does not read the application for a move that is not into or out of applied', async () => {
    await setJobStatus(view('new'), 'saved');
    expect(getDoc).not.toHaveBeenCalled();
    expect(updates().map(([path]) => path)).toEqual(['jobs/job-1']);
  });
});
