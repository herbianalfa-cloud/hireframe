import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetMarksForTest, signalUsable } from '@/lib/perf';
import { watchTodoCount, type TodoCount } from '@/services/pipeline-todo';

import { Shell } from './Shell';
import { SessionContext } from './session';

vi.mock('@/services/pipeline-todo', () => ({ watchTodoCount: vi.fn() }));
vi.mock('@/theme/ThemeSwitcher', () => ({ ThemeSwitcher: () => null }));

function renderShell(path: string, todo: TodoCount) {
  vi.mocked(watchTodoCount).mockImplementation((callback) => {
    callback(todo);
    return () => undefined;
  });
  return render(
    <SessionContext.Provider
      value={{ user: { uid: 'owner', email: 'owner@example.com' }, signOut: vi.fn() }}
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="*" element={<h1>Screen</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}

beforeEach(() => {
  vi.mocked(watchTodoCount).mockReset();
  resetMarksForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Shell pipeline badge', () => {
  it('reads nothing on Today until Today signals usable, then names the count in both navs', async () => {
    vi.useFakeTimers();
    renderShell('/', { status: 'ready', count: 3, capped: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watchTodoCount).not.toHaveBeenCalled();
    // Until then the item has a skeleton and its plain name.
    expect(screen.getAllByTestId('pipeline-badge-skeleton').length).toBeGreaterThan(0);

    await act(async () => {
      signalUsable();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(watchTodoCount).toHaveBeenCalledTimes(1);
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(primary).getByRole('link', { name: 'Pipeline, 3 to do' })).toBeDefined();
    const tabs = screen.getByRole('navigation', { name: 'Tabs' });
    expect(within(tabs).getByRole('link', { name: 'Pipeline, 3 to do' })).toBeDefined();
  });

  it('on another route starts at the first idle moment, without waiting for Today', async () => {
    vi.useFakeTimers();
    renderShell('/jobs', { status: 'ready', count: 1, capped: false });
    expect(watchTodoCount).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    expect(watchTodoCount).toHaveBeenCalledTimes(1);
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(primary).getByRole('link', { name: 'Pipeline, 1 to do' })).toBeDefined();
  });

  it('shows no badge at 0 and a dash, named unavailable, when the read failed', async () => {
    signalUsable();
    const zero = renderShell('/', { status: 'ready', count: 0, capped: false });
    await waitFor(() => {
      expect(watchTodoCount).toHaveBeenCalled();
    });
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(primary).getByRole('link', { name: 'Pipeline' }).textContent).toBe('Pipeline');
    expect(screen.queryAllByTestId('pipeline-badge-skeleton')).toHaveLength(0);
    zero.unmount();

    renderShell('/', { status: 'error' });
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const link = await within(nav).findByRole('link', {
      name: 'Pipeline, to-do count unavailable',
    });
    expect(link.textContent).toContain('–');
  });

  it('keeps the phone tab bar at five columns, with the badge out of the layout flow', async () => {
    signalUsable();
    renderShell('/', { status: 'ready', count: 12, capped: false });
    const tabs = screen.getByRole('navigation', { name: 'Tabs' });
    expect(tabs.className).toContain('grid-cols-5');
    expect(within(tabs).getAllByRole('link')).toHaveLength(5);
    const pipeline = await within(tabs).findByRole('link', { name: 'Pipeline, 12 to do' });
    // The badge is absolutely positioned over the icon, so it can't widen or wrap the column.
    expect(pipeline.querySelector('.absolute')?.textContent).toBe('12');
  });
});
