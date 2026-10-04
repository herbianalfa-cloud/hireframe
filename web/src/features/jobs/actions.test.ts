import { beforeEach, describe, expect, it, vi } from 'vitest';

import { rateJob, setJobStatus, unrateJob, type JobView } from '@/services/jobs';

import { performJobAction } from './actions';
import { makeView } from './fixtures';

vi.mock('@/services/jobs', () => ({
  setJobStatus: vi.fn(),
  rateJob: vi.fn(),
  unrateJob: vi.fn(),
  jobActionErrorMessage: (error: unknown) => (error instanceof Error ? error.message : 'failed'),
}));

beforeEach(() => {
  vi.mocked(setJobStatus).mockReset().mockResolvedValue();
  vi.mocked(rateJob).mockReset().mockResolvedValue();
  vi.mocked(unrateJob).mockReset().mockResolvedValue();
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

  it('removes the rating at once, and puts it back if the write is refused', async () => {
    const rated = makeView('a', {
      feedback: { agree: true, verdict: 'apply', at: new Date('2026-10-14T10:00:00Z') },
    });
    const onPatch = vi.fn<(view: JobView) => void>();
    await performJobAction(rated, { kind: 'unrate' }, { onPatch });
    expect(unrateJob).toHaveBeenCalledWith(rated);
    expect(onPatch.mock.calls[0]?.[0].job.feedback).toBeUndefined();
    expect('feedback' in (onPatch.mock.calls[0]?.[0].raw ?? {})).toBe(false);

    vi.mocked(unrateJob).mockRejectedValue(new Error('nope'));
    const refused = vi.fn<(view: JobView) => void>();
    const result = await performJobAction(rated, { kind: 'unrate' }, { onPatch: refused });
    expect(result).toEqual({ ok: false, message: 'nope' });
    expect(refused.mock.calls[1]?.[0]).toBe(rated);
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
