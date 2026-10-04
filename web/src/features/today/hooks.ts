import type { TodayKpis } from '@hireframe/shared';
import { useEffect, useState } from 'react';

import {
  loadTodayKpis,
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

export function useSpend(): LiveState<SpendView> {
  const [state, setState] = useState<LiveState<SpendView>>({ status: 'loading' });
  useEffect(() => watchSpend(new Date(), setState), []);
  return state;
}

export type KpiState =
  { status: 'loading' } | { status: 'ready'; kpis: TodayKpis } | { status: 'error' };

/**
 * The tile counts, re-read when `refreshKey` changes (after an action). The weekly target is
 * applied by the caller with `todayKpis`, so waiting for the criteria doesn't delay the counts.
 */
export function useTodayKpis(refreshKey: number): KpiState {
  const [state, setState] = useState<KpiState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    loadTodayKpis(new Date(), 1).then(
      (kpis) => {
        if (!cancelled) setState({ status: 'ready', kpis });
      },
      () => {
        if (!cancelled) setState({ status: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return state;
}
