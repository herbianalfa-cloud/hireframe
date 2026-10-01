import { useEffect, useState } from 'react';

import type { LiveState } from '@/services/profile';
import {
  countJobs,
  watchBrokenBoards,
  watchRecentRuns,
  watchSources,
  type BoardView,
  type RunView,
  type SourceView,
} from '@/services/system';

export function useSources(): LiveState<SourceView[]> {
  const [state, setState] = useState<LiveState<SourceView[]>>({ status: 'loading' });
  useEffect(() => watchSources(setState), []);
  return state;
}

export function useRecentRuns(): LiveState<RunView[]> {
  const [state, setState] = useState<LiveState<RunView[]>>({ status: 'loading' });
  useEffect(() => watchRecentRuns(setState), []);
  return state;
}

export function useBrokenBoards(): LiveState<BoardView[]> {
  const [state, setState] = useState<LiveState<BoardView[]>>({ status: 'loading' });
  useEffect(() => watchBrokenBoards(setState), []);
  return state;
}

/** The stored job count, re-read whenever `refreshKey` changes (e.g. after a scan). */
export function useJobCount(refreshKey: number): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    countJobs().then(
      (value) => {
        if (!cancelled) setCount(value);
      },
      () => {
        if (!cancelled) setCount(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return count;
}
