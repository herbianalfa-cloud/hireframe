import { useCallback, useState } from 'react';

import { isJobSort, type JobSort } from '@/features/jobs/sort';
import type { TodayListId } from '@/services/dashboard';

/** Apply is ranked by value; near misses and wildcards are review queues, so newest first. */
export const DEFAULT_TODAY_SORT: Readonly<Record<TodayListId, JobSort>> = {
  apply: 'best',
  near_miss: 'newest',
  wildcard: 'newest',
};

const storageKey = (list: TodayListId) => `hf:today-sort:${list}`;

function readSort(list: TodayListId): JobSort {
  try {
    const stored = window.localStorage.getItem(storageKey(list));
    if (isJobSort(stored)) return stored;
  } catch {
    // Storage can be blocked or throw; the default is fine.
  }
  return DEFAULT_TODAY_SORT[list];
}

/** A list's sort, remembered per list in this browser only. Never required to work. */
export function useTodaySort(list: TodayListId): [JobSort, (sort: JobSort) => void] {
  const [sort, setSortState] = useState(() => readSort(list));
  const setSort = useCallback(
    (next: JobSort) => {
      setSortState(next);
      try {
        window.localStorage.setItem(storageKey(list), next);
      } catch {
        // Not remembered; the choice still applies for this visit.
      }
    },
    [list],
  );
  return [sort, setSort];
}
