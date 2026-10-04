import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dismissToast, getToast, showToast } from '@/lib/toast';

import { ToastHost } from './toast-host';

afterEach(() => {
  vi.useRealTimers();
  const toast = getToast();
  if (toast) dismissToast(toast.id);
});

describe('ToastHost', () => {
  it('keeps an empty polite live region mounted, so the first toast is announced', () => {
    render(<ToastHost />);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');
  });

  it('shows a toast inside the live region without taking focus', async () => {
    render(
      <>
        <button>Row</button>
        <ToastHost />
      </>,
    );
    screen.getByRole('button', { name: 'Row' }).focus();
    act(() => {
      showToast({ message: 'Saved' });
    });
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(screen.getByRole('status').contains(screen.getByText('Saved'))).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Row' }));
  });

  it('runs Undo once and clears the toast', async () => {
    const run = vi.fn();
    render(<ToastHost />);
    act(() => {
      showToast({ message: 'Skipped', action: { label: 'Undo', run } });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Skipped')).toBeNull();
  });

  it('dismisses itself, later when it carries an action', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ToastHost />);
    act(() => {
      showToast({ message: 'Saved' });
    });
    await screen.findByText('Saved');
    act(() => {
      vi.advanceTimersByTime(5100);
    });
    expect(screen.queryByText('Saved')).toBeNull();

    act(() => {
      showToast({ message: 'Skipped', action: { label: 'Undo', run: vi.fn() } });
    });
    await screen.findByText('Skipped');
    act(() => {
      vi.advanceTimersByTime(5100);
    });
    expect(screen.getByText('Skipped')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText('Skipped')).toBeNull();
  });

  it('stays while hovered and goes after the pointer leaves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ToastHost />);
    act(() => {
      showToast({ message: 'Saved' });
    });
    const toast = (await screen.findByText('Saved')).closest('div');
    if (!toast) throw new Error('no toast');
    await userEvent.hover(toast);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByText('Saved')).toBeTruthy();
    await userEvent.unhover(toast);
    act(() => {
      vi.advanceTimersByTime(5100);
    });
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('marks an error toast as an alert', async () => {
    render(<ToastHost />);
    act(() => {
      showToast({ message: 'Nope', tone: 'error' });
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Nope');
  });

  it('sits above the phone tab bar and clear of the sidebar on desktop', () => {
    render(<ToastHost />);
    const { className } = screen.getByRole('status');
    // Tab bar: min-h-14 (3.5rem) + the safe-area inset; the toast starts above both.
    expect(className).toContain('bottom-[calc(4.5rem+env(safe-area-inset-bottom))]');
    expect(className).toContain('md:bottom-6');
    expect(className).toContain('md:left-60');
  });

  it('lives outside the app root, so an open dialog does not hide it', () => {
    const { container } = render(<ToastHost />);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(document.body.querySelector(':scope > [data-toast-region]')).not.toBeNull();
  });
});
