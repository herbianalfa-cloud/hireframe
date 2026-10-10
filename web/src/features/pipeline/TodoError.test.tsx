import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SummaryBar } from '@/features/today/SummaryBar';

import { PipelineBadge } from './PipelineBadge';
import { useTodoCount } from './useTodoCount';

// The real count service over a fake Firestore: only the listener and the dashboard reads are
// faked, so the badge and the summary bar's slot both see what the listener really publishes.
const state = vi.hoisted(() => ({
  onNext: undefined as ((snapshot: { size: number }) => void) | undefined,
  onError: undefined as ((error: { code: string }) => void) | undefined,
}));

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  collection: (_db: unknown, path: string) => ({ path }),
  query: (source: unknown) => source,
  limit: (n: number) => ({ type: 'limit', n }),
  onSnapshot: (
    _q: unknown,
    next: (snapshot: { size: number }) => void,
    error: (e: { code: string }) => void,
  ) => {
    state.onNext = next;
    state.onError = error;
    return () => undefined;
  },
}));
vi.mock('@/services/firebase', () => ({ getFirebase: () => Promise.resolve({ db: {} }) }));
vi.mock('@/services/dashboard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadSummaryCounts: () => new Promise(() => undefined),
  watchLastRun: () => () => undefined,
  watchSpend: () => () => undefined,
}));

function Badge() {
  return <PipelineBadge state={useTodoCount(true)} />;
}

afterEach(cleanup);

describe('after the count listener fails', () => {
  it('shows "–" on the nav badge and on Things to do, and does not retry', async () => {
    const { container } = render(
      <MemoryRouter>
        <span data-testid="badge">
          <Badge />
        </span>
        <SummaryBar weeklyTarget={5} refreshKey={0} />
      </MemoryRouter>,
    );
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    act(() => {
      state.onNext?.({ size: 2 });
    });
    expect(screen.getByTestId('badge').textContent).toBe('2');
    expect(screen.getByRole('link', { name: 'Things to do 2' })).toBeDefined();

    act(() => {
      state.onError?.({ code: 'permission-denied' });
    });
    expect(screen.getByTestId('badge').textContent).toBe('–');
    const slot = screen.getByRole('link', { name: 'Things to do unavailable' });
    expect(slot.textContent).toContain('–');
    expect(container.textContent).not.toContain('questions to answer');
  });
});
