import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dismissToast, getToast } from '@/lib/toast';
import { rateJob, setJobStatus, type JobView } from '@/services/jobs';

import { performJobAction } from './actions';
import { makeView } from './fixtures';

vi.mock('@/services/jobs', () => ({
  setJobStatus: vi.fn(),
  rateJob: vi.fn(),
  jobActionErrorMessage: (error: unknown) => (error instanceof Error ? error.message : 'failed'),
}));

function clearToast() {
  const toast = getToast();
  if (toast) dismissToast(toast.id);
}

beforeEach(() => {
  vi.mocked(setJobStatus).mockReset().mockResolvedValue();
  vi.mocked(rateJob).mockReset().mockResolvedValue();
});
afterEach(clearToast);

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
    expect(getToast()).toBeNull();
    confirm();
    await done;
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(getToast()?.message).toBe('Saved');
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
    expect(getToast()).toBeNull();
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

  it.each([
    ['saved', 'Saved'],
    ['applied', 'Marked applied'],
    ['skipped', 'Skipped'],
  ] as const)('toasts "%s" with Undo', async (to, message) => {
    await performJobAction(makeView('a'), { kind: 'status', to });
    expect(getToast()?.message).toBe(message);
    expect(getToast()?.action?.label).toBe('Undo');
  });

  it('toasts ratings, without Undo (the rules cannot remove a rating)', async () => {
    await performJobAction(makeView('a'), { kind: 'rate', input: { agree: true } });
    expect(getToast()).toMatchObject({ message: 'Rated 👍' });
    expect(getToast()?.action).toBeUndefined();
    await performJobAction(makeView('a'), { kind: 'rate', input: { agree: false } });
    expect(getToast()?.message).toBe('Rated 👎');
  });

  it('offers no Undo out of applied: going back would stamp a new applied date', async () => {
    await performJobAction(makeView('a', { status: 'applied' }), { kind: 'status', to: 'new' });
    expect(getToast()?.message).toBe('Marked not applied');
    expect(getToast()?.action).toBeUndefined();
  });

  it('Undo puts the job back to the status it had and patches the list', async () => {
    const onPatch = vi.fn<(view: JobView) => void>();
    await performJobAction(
      makeView('a', { status: 'saved' }),
      { kind: 'status', to: 'applied' },
      { onPatch },
    );
    getToast()?.action?.run();
    await vi.waitFor(() => {
      expect(setJobStatus).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(setJobStatus).mock.calls[1]?.[0].job.status).toBe('applied');
    expect(vi.mocked(setJobStatus).mock.calls[1]?.[1]).toBe('saved');
    await vi.waitFor(() => {
      expect(getToast()?.message).toBe('Undone');
    });
    expect(getToast()?.action).toBeUndefined();
    expect(onPatch.mock.calls.at(-1)?.[0].job.status).toBe('saved');
  });

  it('toasts the error if Undo is refused, and rolls back', async () => {
    const onPatch = vi.fn<(view: JobView) => void>();
    await performJobAction(makeView('a'), { kind: 'status', to: 'saved' }, { onPatch });
    vi.mocked(setJobStatus).mockRejectedValue(new Error('This job changed since you opened it.'));
    getToast()?.action?.run();
    await vi.waitFor(() => {
      expect(getToast()?.tone).toBe('error');
    });
    expect(getToast()?.message).toContain('changed');
    expect(onPatch.mock.calls.at(-1)?.[0].job.status).toBe('saved');
  });
});
