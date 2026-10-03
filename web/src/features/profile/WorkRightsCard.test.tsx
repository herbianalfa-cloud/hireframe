import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveWorkRights, watchWorkRights, type WorkRightsView } from '@/services/profile';

import { WorkRightsCard } from './WorkRightsCard';

vi.mock('@/services/profile', () => ({
  watchWorkRights: vi.fn(),
  saveWorkRights: vi.fn(),
}));

function given(data: WorkRightsView) {
  vi.mocked(watchWorkRights).mockImplementation((callback) => {
    callback({ status: 'ready', data, invalid: 0 });
    return () => undefined;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveWorkRights).mockResolvedValue();
});

describe('WorkRightsCard', () => {
  it('explains that unset work rights only flag postings, and saves a choice', async () => {
    const user = userEvent.setup();
    given(null);
    render(<WorkRightsCard />);
    expect(screen.getByText(/flagged, not skipped/)).toBeDefined();
    const save = screen.getByRole('button', { name: 'Save work rights' });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('radio', { name: /Needs sponsorship/ }));
    await user.click(save);
    expect(saveWorkRights).toHaveBeenCalledWith({ workRights: 'needs_sponsorship' }, false);
    expect(await screen.findByText('Saved. The next scan uses it.')).toBeDefined();
  });

  it('asks for an optional end date only for time-limited permission', async () => {
    const user = userEvent.setup();
    given(null);
    render(<WorkRightsCard />);
    expect(screen.queryByLabelText('Valid until (optional)')).toBeNull();
    await user.click(screen.getByRole('radio', { name: /Time-limited permission/ }));
    await user.type(screen.getByLabelText('Valid until (optional)'), '2028-06-30');
    await user.click(screen.getByRole('button', { name: 'Save work rights' }));
    expect(saveWorkRights).toHaveBeenCalledWith(
      { workRights: 'time_limited', validUntil: '2028-06-30' },
      false,
    );
  });

  it('starts from the stored setting and drops the date when the choice changes', async () => {
    const user = userEvent.setup();
    given({ workRights: 'time_limited', validUntil: '2028-06-30' });
    render(<WorkRightsCard />);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Time-limited/ }).checked).toBe(
      true,
    );
    expect(screen.getByLabelText<HTMLInputElement>('Valid until (optional)').value).toBe(
      '2028-06-30',
    );
    await user.click(screen.getByRole('radio', { name: /No restrictions/ }));
    await user.click(screen.getByRole('button', { name: 'Save work rights' }));
    expect(saveWorkRights).toHaveBeenCalledWith({ workRights: 'unrestricted' }, true);
  });

  it('shows an error when saving fails', async () => {
    const user = userEvent.setup();
    given(null);
    vi.mocked(saveWorkRights).mockRejectedValue(new Error('offline'));
    render(<WorkRightsCard />);
    await user.click(screen.getByRole('radio', { name: /No restrictions/ }));
    await user.click(screen.getByRole('button', { name: 'Save work rights' }));
    expect(
      await screen.findByText("Couldn't save. Check your connection and try again."),
    ).toBeDefined();
  });

  it('shows loading and error states', () => {
    vi.mocked(watchWorkRights).mockImplementation((callback) => {
      callback({ status: 'loading' });
      return () => undefined;
    });
    const { unmount } = render(<WorkRightsCard />);
    expect(screen.getByRole('status', { name: 'Loading work rights' })).toBeDefined();
    unmount();
    vi.mocked(watchWorkRights).mockImplementation((callback) => {
      callback({
        status: 'error',
        message: "Couldn't load your work rights. Reload to try again.",
      });
      return () => undefined;
    });
    render(<WorkRightsCard />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load your work rights");
  });
});
