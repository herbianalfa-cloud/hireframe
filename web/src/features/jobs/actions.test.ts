import { beforeEach, describe, expect, it, vi } from 'vitest';

import { rateJob, setJobStatus, type JobView } from '@/services/jobs';

import { performJobAction } from './actions';
import { makeView } from './fixtures';

vi.mock('@/services/jobs', () => ({
  setJobStatus: vi.fn(),
  rateJob: vi.fn(),
  jobActionErrorMessage: (error: unknown) => (error instanceof Error ? error.message : 'failed'),
}));

beforeEach(() => {
  vi.mocked(setJobStatus).mockReset().mockResolvedValue();
  vi.mocked(rateJob).mockReset().mockResolvedValue();
});

describe('performJobAction', () => {
  it('shows the new state before the write is confirmed', async () => {
    let confirm: () => void = () => undefined;
    vi.mocked(setJobStatus).mockReturnValue(
      new Promise<void>((resolve) => {
        confirm = resolve;
      }),
    );
    const onPatch = vi.fn<(view: JobView) => void>();
    const onCommitted = vi.fn();
    const view = makeView('a');
    const done = performJobAction(view, { kind: 'status', to: 'saved' }, { onPatch, onCommitted });
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch.mock.calls[0]?.[0].job.status).toBe('saved');
    expect(onCommitted).not.toHaveBeenCalled();
    confirm();
    await done;
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it('rolls back to the job as it was and says why when the write is refused', async () => {
    vi.mocked(setJobStatus).mockRejectedValue(new Error('This job changed since you opened it.'));
    const onPatch = vi.fn<(view: JobView) => void>();
    const onCommitted = vi.fn();
    const view = makeView('a');
    const result = await performJobAction(
      view,
      { kind: 'status', to: 'applied' },
      { onPatch, onCommitted },
    );
    expect(result).toEqual({ ok: false, message: 'This job changed since you opened it.' });
    expect(onPatch).toHaveBeenCalledTimes(2);
    expect(onPatch.mock.calls[0]?.[0].job.status).toBe('applied');
    expect(onPatch.mock.calls[1]?.[0]).toBe(view);
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('rolls back a refused rating too', async () => {
    vi.mocked(rateJob).mockRejectedValue(new Error('nope'));
    const onPatch = vi.fn<(view: JobView) => void>();
    const view = makeView('a');
    await performJobAction(view, { kind: 'rate', input: { agree: true } }, { onPatch });
    expect(onPatch.mock.calls[0]?.[0].job.feedback).toMatchObject({ agree: true });
    expect(onPatch.mock.calls[1]?.[0]).toBe(view);
  });

  it('ignores a second action on a job whose write is still in flight', async () => {
    let confirm: () => void = () => undefined;
    vi.mocked(setJobStatus).mockReturnValue(
      new Promise<void>((resolve) => {
        confirm = resolve;
      }),
    );
    const view = makeView('busy');
    const first = performJobAction(view, { kind: 'status', to: 'saved' });
    const second = await performJobAction(view, { kind: 'status', to: 'skipped' });
    expect(second).toEqual({ ok: false, busy: true });
    expect(setJobStatus).toHaveBeenCalledTimes(1);
    confirm();
    await first;
    await expect(performJobAction(view, { kind: 'status', to: 'skipped' })).resolves.toMatchObject({
      ok: true,
    });
  });
});
