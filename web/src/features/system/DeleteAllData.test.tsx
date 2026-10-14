import type { DeleteAllDataResult } from '@hireframe/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteAllData, previewCount } from '@/services/wipe';

import { DeleteAllData } from './DeleteAllData';

vi.mock('@/services/wipe', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deleteAllData: vi.fn(),
  previewCount: vi.fn(),
}));
vi.mock('@/services/profile', () => ({
  callableErrorMessage: (error: unknown) => (error instanceof Error ? error.message : 'failed'),
}));

const call = vi.mocked(deleteAllData);

function pass(overrides: Partial<DeleteAllDataResult> = {}): DeleteAllDataResult {
  return {
    done: false,
    deleted: { documents: 5, files: 0 },
    remaining: ['jobs', 'runs'],
    ...overrides,
  };
}

async function openDialog() {
  render(<DeleteAllData />);
  await userEvent.click(screen.getByRole('button', { name: 'Delete all my data' }));
}

const typeDelete = (text = 'DELETE') =>
  userEvent.type(screen.getByLabelText(/type delete to confirm/i), text);

beforeEach(() => {
  vi.mocked(previewCount).mockImplementation((path) =>
    path.includes('events') ? Promise.reject(new Error('offline')) : Promise.resolve(7),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DeleteAllData (ADR-057)', () => {
  it('shows the preview counts, with one failed count as unavailable', async () => {
    await openDialog();
    expect((await screen.findAllByText('7')).length).toBeGreaterThan(0);
    expect(await screen.findByText('unavailable')).toBeTruthy();
    expect(screen.getByText(/saved email alert records \(not counted\)/i)).toBeTruthy();
    expect(screen.getByText(/backups keep data for up to 8 weeks/i)).toBeTruthy();
    expect(screen.getByText(/re-creates the watchlist from the seed/i)).toBeTruthy();
  });

  it('leaves the profile box off by default and keeps the button disabled until DELETE', async () => {
    await openDialog();
    const box = screen.getByRole('checkbox', { name: /also reset profile/i });
    expect((box as HTMLInputElement).checked).toBe(false);
    const button = screen.getByRole('button', { name: 'Delete all my data', hidden: false });
    const buttons = screen.getAllByRole('button', { name: 'Delete all my data' });
    const submit = buttons.find((b) => b.getAttribute('type') === 'submit') ?? button;
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await typeDelete('delete');
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(screen.getByLabelText(/type delete to confirm/i));
    await typeDelete();
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    [false, false],
    [true, true],
  ])('sends resetProfile %s when the box is %s', async (ticked, expected) => {
    call.mockResolvedValue(pass({ done: true, remaining: [] }));
    await openDialog();
    if (ticked)
      await userEvent.click(screen.getByRole('checkbox', { name: /also reset profile/i }));
    await typeDelete();
    const submit = screen
      .getAllByRole('button', { name: 'Delete all my data' })
      .find((b) => b.getAttribute('type') === 'submit');
    await userEvent.click(submit as HTMLElement);
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith({ confirm: 'DELETE', resetProfile: expected });
    });
  });

  async function start() {
    await openDialog();
    await typeDelete();
    const submit = screen
      .getAllByRole('button', { name: 'Delete all my data' })
      .find((b) => b.getAttribute('type') === 'submit');
    await userEvent.click(submit as HTMLElement);
  }

  it('loops until done and shows a summary', async () => {
    call
      .mockResolvedValueOnce(pass())
      .mockResolvedValueOnce(pass({ remaining: ['runs'] }))
      .mockResolvedValueOnce(
        pass({ done: true, deleted: { documents: 0, files: 0 }, remaining: [] }),
      );
    await start();
    expect(await screen.findByText(/^Done\. Deleted 10 documents and 0 files/)).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('stops at 20 calls and shows Continue, which runs 20 more', async () => {
    call.mockResolvedValue(pass());
    await start();
    const continueButton = await screen.findByRole('button', { name: 'Continue' });
    expect(call).toHaveBeenCalledTimes(20);
    expect(screen.getByText(/still to do: jobs, runs/)).toBeTruthy();
    await userEvent.click(continueButton);
    await waitFor(() => {
      expect(call).toHaveBeenCalledTimes(40);
    });
  });

  it('stops on an error, shows the message and retries nothing', async () => {
    call
      .mockResolvedValueOnce(pass())
      .mockRejectedValueOnce(new Error('Wait for the CV being written.'));
    await start();
    expect((await screen.findByRole('alert')).textContent).toBe('Wait for the CV being written.');
    expect(call).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });
});
