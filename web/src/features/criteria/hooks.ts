import { useEffect, useState } from 'react';

import {
  watchCriteriaHistory,
  watchCurrentCriteria,
  type CriteriaState,
  type CriteriaVersionSummary,
} from '@/services/criteria';

export type HistoryState =
  | { status: 'loading' }
  | { status: 'ready'; versions: CriteriaVersionSummary[] }
  | { status: 'error'; message: string };

export function useCurrentCriteria(): CriteriaState {
  const [state, setState] = useState<CriteriaState>({ status: 'loading' });
  useEffect(() => watchCurrentCriteria(setState), []);
  return state;
}

export function useCriteriaHistory(): HistoryState {
  const [state, setState] = useState<HistoryState>({ status: 'loading' });
  useEffect(() => watchCriteriaHistory(setState), []);
  return state;
}
