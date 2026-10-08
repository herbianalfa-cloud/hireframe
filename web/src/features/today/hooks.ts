import { useEffect, useState } from 'react';

import {
  loadTodayCounts,
  watchAddedByYou,
  type TodayCountResults,
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

export type KpiState = { status: 'loading' } | { status: 'ready'; counts: TodayCountResults };

/**
 * The tile counts, re-read when `refreshKey` changes (after an action). Each count fails on its
 * own (null), and the weekly target is applied by the caller, so waiting for the criteria
 * doesn't delay the counts.
 */
export function useTodayKpis(refreshKey: number): KpiState {
  const [state, setState] = useState<KpiState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    void loadTodayCounts(new Date()).then(
      (counts) => {
        if (!cancelled) setState({ status: 'ready', counts });
      },
      () => {
        // Only a failure before any count was read (no Firebase); show every tile as unavailable.
        if (!cancelled) {
          setState({
            status: 'ready',
            counts: { toApply: null, toReview: null, judgedToday: null, appliedThisWeek: null },
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
