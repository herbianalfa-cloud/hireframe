import type { Run } from '@hireframe/shared';
import { useEffect, useState } from 'react';

import {
  loadSummaryCounts,
  watchAddedByYou,
  watchLastRun,
  type SummaryCountResults,
  watchSpend,
  watchTodayList,
  type SpendView,
  type TodayListId,
} from '@/services/dashboard';
import type { JobView } from '@/services/jobs';
import type { LiveState } from '@/services/profile';

export function useTodayList(list: TodayListId): LiveState<JobView[]> {
  const [state, setState] = useState<LiveState<JobView[]>>({ status: 'loading' });
  useEffect(() => watchTodayList(list, setState), [list]);
  return state;
}

/** The newest jobs added from Lookup; Today mounts the section only after `hf:usable`. */
export function useAddedByYou(): LiveState<JobView[]> {
  const [state, setState] = useState<LiveState<JobView[]>>({ status: 'loading' });
  useEffect(() => watchAddedByYou(setState), []);
  return state;
}

export function useSpend(): LiveState<SpendView> {
  const [state, setState] = useState<LiveState<SpendView>>({ status: 'loading' });
  useEffect(() => watchSpend(new Date(), setState), []);
  return state;
}

/** The newest run, live. Only the summary bar uses it, so it starts after `hf:usable`. */
export function useLastRun(): LiveState<Run | null> {
  const [state, setState] = useState<LiveState<Run | null>>({ status: 'loading' });
  useEffect(() => watchLastRun(setState), []);
  return state;
}

export type SummaryState = { status: 'loading' } | { status: 'ready'; counts: SummaryCountResults };

/**
 * The summary bar's counts, re-read when `refreshKey` changes (after an action). Each count fails
 * on its own (null), and the weekly target is applied by the caller. The bar mounts after
 * `hf:usable`, so none of these reads starts before it (ADR-051).
 */
export function useSummaryCounts(refreshKey: number): SummaryState {
  const [state, setState] = useState<SummaryState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    void loadSummaryCounts(new Date()).then(
      (counts) => {
        if (!cancelled) setState({ status: 'ready', counts });
      },
      () => {
        // Only a failure before any count was read (no Firebase); show every count as unavailable.
        if (!cancelled) {
          setState({
            status: 'ready',
            counts: { apply: null, nearMiss: null, wildcard: null, appliedThisWeek: null },
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return state;
}
