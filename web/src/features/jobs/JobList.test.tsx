import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setJobStatus } from '@/services/jobs';

import { makeView, NOW } from './fixtures';
import { JobList } from './JobList';

vi.mock('@/services/jobs', () => ({
  setJobStatus: vi.fn(),
  jobActionErrorMessage: (error: unknown) => (error instanceof Error ? error.message : 'failed'),
}));

const VIEWS = [
  makeView('a', { title: 'First role' }),
  makeView('b', { title: 'Second role' }),
  makeView('c', { title: 'Third role' }),
];

function setup() {
  const onOpen = vi.fn();
  const onCommitted = vi.fn();
  render(
    <>
      <input aria-label="Outside" />
      <JobList jobs={VIEWS} label="Test jobs" now={NOW} onOpen={onOpen} onCommitted={onCommitted} />
    </>,
  );
  return { onOpen, onCommitted, rows: () => screen.getAllByRole('button') };
}

beforeEach(() => {
  vi.mocked(setJobStatus).mockReset();
  vi.mocked(setJobStatus).mockResolvedValue();
});

describe('JobList', () => {
  it('shows title, company, age, scores and reason, and opens a row on click', async () => {
    const { onOpen } = setup();
    const first = screen.getByRole('button', { name: /First role/ });
    expect(first.textContent).toContain('First role');
    expect(first.textContent).toContain('Acme Test Co');
    expect(first.textContent).toContain('3 days');
    expect(first.textContent).toContain('fit 8.2 · luck 7.1');
    expect(first.textContent).toContain('Strong match on SQL reporting');
    await userEvent.click(first);
    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('moves with j and k, and stops at the ends', async () => {
    const { rows } = setup();
    rows()[0]?.focus();
    await userEvent.keyboard('j');
    expect(document.activeElement).toBe(rows()[1]);
    await userEvent.keyboard('jj');
    expect(document.activeElement).toBe(rows()[2]);
    await userEvent.keyboard('kkk');
    expect(document.activeElement).toBe(rows()[0]);
  });

  it('marks the focused job applied with a, skips it with s', async () => {
    const { onCommitted, rows } = setup();
    rows()[1]?.focus();
    await userEvent.keyboard('a');
    await waitFor(() => {
      expect(onCommitted).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(setJobStatus).mock.calls[0]?.[0].id).toBe('b');
    expect(vi.mocked(setJobStatus).mock.calls[0]?.[1]).toBe('applied');
    await userEvent.keyboard('s');
    await waitFor(() => {
      expect(onCommitted).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(setJobStatus).mock.calls[1]?.[1]).toBe('skipped');
  });

  it('opens the posting with o in a new tab without a referrer', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { rows } = setup();
    rows()[0]?.focus();
    await userEvent.keyboard('o');
    expect(open).toHaveBeenCalledWith(
      'https://jobs.example.test/acme/1',
      '_blank',
      'noopener,noreferrer',
    );
    open.mockRestore();
  });

  it('ignores the keys when focus is outside the list or in a field (WCAG 2.1.4)', async () => {
    setup();
    screen.getByLabelText('Outside').focus();
    await userEvent.keyboard('jask');
    expect(setJobStatus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText('Outside'));
  });

  it('shows why an action failed', async () => {
    vi.mocked(setJobStatus).mockRejectedValue(new Error('This job changed since you opened it.'));
    const { onCommitted, rows } = setup();
    rows()[0]?.focus();
    await userEvent.keyboard('a');
    expect((await screen.findByRole('alert')).textContent).toContain('This job changed');
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('does not repeat an action the job already has', async () => {
    const onCommitted = vi.fn();
    render(
      <JobList
        jobs={[makeView('x', { status: 'applied' })]}
        label="Test jobs"
        now={NOW}
        onOpen={vi.fn()}
        onCommitted={onCommitted}
      />,
    );
    screen.getByRole('button').focus();
    await userEvent.keyboard('a');
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  it('does not skip an applied job (it would clear the applied stamps)', async () => {
    render(
      <JobList
        jobs={[makeView('x', { status: 'applied' })]}
        label="Test jobs"
        now={NOW}
        onOpen={vi.fn()}
        onCommitted={vi.fn()}
      />,
    );
    screen.getByRole('button').focus();
    await userEvent.keyboard('s');
    expect(setJobStatus).not.toHaveBeenCalled();
  });
});

describe('JobList in place', () => {
  it('patches the row at once and keeps keyboard focus on it', async () => {
    const onPatch = vi.fn();
    const { rerender } = render(
      <JobList jobs={VIEWS} label="Test jobs" now={NOW} onOpen={vi.fn()} onPatch={onPatch} />,
    );
    const rows = () => screen.getAllByRole('button');
    rows()[1]?.focus();
    await userEvent.keyboard('s');
    await waitFor(() => {
      expect(onPatch).toHaveBeenCalled();
    });
    const patched = onPatch.mock.calls[0]?.[0] as (typeof VIEWS)[number];
    expect(patched.id).toBe('b');
    expect(patched.job.status).toBe('skipped');
    rerender(
      <JobList
        jobs={VIEWS.map((view) => (view.id === 'b' ? patched : view))}
        label="Test jobs"
        now={NOW}
        onOpen={vi.fn()}
        onPatch={onPatch}
      />,
    );
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows()[1]?.textContent).toContain('skipped');
    expect(rows()).toHaveLength(3);
  });

  it('asks to roll the row back when the write is refused', async () => {
    vi.mocked(setJobStatus).mockRejectedValue(new Error('This job changed since you opened it.'));
    const onPatch = vi.fn();
    render(<JobList jobs={VIEWS} label="Test jobs" now={NOW} onOpen={vi.fn()} onPatch={onPatch} />);
    screen.getAllByRole('button')[0]?.focus();
    await userEvent.keyboard('a');
    expect((await screen.findByRole('alert')).textContent).toContain('changed');
    expect(onPatch).toHaveBeenCalledTimes(2);
    expect(onPatch.mock.calls[1]?.[0]).toBe(VIEWS[0]);
  });

  it('hands focus to the next row when the focused one leaves a live list', () => {
    const props = { label: 'Test jobs', now: NOW, onOpen: vi.fn() };
    const { rerender } = render(<JobList jobs={VIEWS} {...props} />);
    screen.getAllByRole('button')[1]?.focus();
    rerender(<JobList jobs={VIEWS.filter((view) => view.id !== 'b')} {...props} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Third role/ }));
  });

  it('leaves focus alone when the user clicked away before a row left', () => {
    const props = { label: 'Test jobs', now: NOW, onOpen: vi.fn() };
    const { rerender } = render(
      <>
        <input aria-label="Outside" />
        <JobList jobs={VIEWS} {...props} />
      </>,
    );
    screen.getAllByRole('button')[1]?.focus();
    screen.getByLabelText('Outside').focus();
    (document.activeElement as HTMLElement).blur();
    rerender(
      <>
        <input aria-label="Outside" />
        <JobList jobs={VIEWS.filter((view) => view.id !== 'b')} {...props} />
      </>,
    );
    expect(document.activeElement).toBe(document.body);
  });
});
