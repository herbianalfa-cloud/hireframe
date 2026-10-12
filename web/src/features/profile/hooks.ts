import { useCallback, useEffect, useState } from 'react';

import {
  watchCvHeader,
  watchDocuments,
  watchFacts,
  watchFactVersions,
  watchWorkRights,
  type CvHeaderView,
  type DocumentView,
  type FactView,
  type LiveState,
  type Unsubscribe,
  type VersionView,
  type WorkRightsView,
} from '@/services/profile';

function useLive<T>(subscribe: (callback: (state: LiveState<T>) => void) => Unsubscribe) {
  const [state, setState] = useState<LiveState<T>>({ status: 'loading' });
  useEffect(() => subscribe(setState), [subscribe]);
  return state;
}

export function useFacts(): LiveState<FactView[]> {
  return useLive(watchFacts);
}

export function useDocuments(): LiveState<DocumentView[]> {
  return useLive(watchDocuments);
}

/** History of one fact; mount it per fact (the state resets with the component). */
export function useFactVersions(factId: string): LiveState<VersionView[]> {
  const subscribe = useCallback(
    (callback: (state: LiveState<VersionView[]>) => void) => watchFactVersions(factId, callback),
    [factId],
  );
  return useLive(subscribe);
}

export function useWorkRights(): LiveState<WorkRightsView> {
  return useLive(watchWorkRights);
}

export function useCvHeader(): LiveState<CvHeaderView | null> {
  return useLive(watchCvHeader);
}
