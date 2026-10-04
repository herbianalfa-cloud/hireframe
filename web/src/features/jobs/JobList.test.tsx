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
  const onChanged = vi.fn();
  render(
    <>
      <input aria-label="Outside" />
      <JobList jobs={VIEWS} label="Test jobs" now={NOW} onOpen={onOpen} onChanged={onChanged} />
    </>,
  );
  return { onOpen, onChanged, rows: () => screen.getAllByRole('button') };
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
    const { onChanged, rows } = setup();
    rows()[1]?.focus();
    await userEvent.keyboard('a');
    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(setJobStatus).mock.calls[0]?.[0].id).toBe('b');
    expect(vi.mocked(setJobStatus).mock.calls[0]?.[1]).toBe('applied');
    await userEvent.keyboard('s');
    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(2);
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
    const { onChanged, rows } = setup();
    rows()[0]?.focus();
    await userEvent.keyboard('a');
    expect((await screen.findByRole('alert')).textContent).toContain('This job changed');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('does not repeat an action the job already has', async () => {
    const onChanged = vi.fn();
    render(
      <JobList
        jobs={[makeView('x', { status: 'applied' })]}
        label="Test jobs"
        now={NOW}
        onOpen={vi.fn()}
        onChanged={onChanged}
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
        onChanged={vi.fn()}
      />,
    );
    screen.getByRole('button').focus();
    await userEvent.keyboard('s');
    expect(setJobStatus).not.toHaveBeenCalled();
  });
});
