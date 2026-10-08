import type { Agreement } from '@hireframe/shared';
import type { JobDescription } from '@hireframe/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  JOBS_PAGE_SIZE,
  loadJobDescription,
  loadJobsPage,
  loadJobsWindow,
  watchJob,
  type JobFilters,
  type JobsPage,
  type JobView,
} from '@/services/jobs';
import { filterJobs, sortJobs, type JobFilter, type JobSort } from './sort';
import { loadAgreement } from '@/services/dashboard';
import type { LiveState } from '@/services/profile';

export function useJob(jobId: string): LiveState<JobView | null> {
  const [state, setState] = useState<LiveState<JobView | null>>({ status: 'loading' });
  useEffect(() => watchJob(jobId, setState), [jobId]);
  return state;
}

export type DescriptionState =
  | { status: 'loading' }
  | { status: 'ready'; description: JobDescription | null }
  | { status: 'error' };

export function useJobDescription(jobId: string): DescriptionState {
  const [state, setState] = useState<DescriptionState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    loadJobDescription(jobId).then(
      (description) => {
        if (!cancelled) setState({ status: 'ready', description });
      },
      () => {
        if (!cancelled) setState({ status: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [jobId]);
  return state;
}

export type JobsListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      jobs: JobView[];
      invalid: number;
      more: boolean;
      loadingMore: boolean;
      /** A full read hit its cap, so older matching jobs may be missing. */
      capped: boolean;
    };

interface Loaded {
  /** The filters this result is for; a result for other filters counts as loading. */
  sig: string;
  jobs: JobView[];
  invalid: number;
  cursor: JobsPage['cursor'];
  capped: boolean;
  failed: boolean;
}

/**
 * Pages of jobs for a filter set. Changing the filters starts over. An action never reloads:
 * `patch` swaps one job in place, so loaded pages, scroll and focus stay as they are.
 * With `full`, one read loads the newest `JOBS_SORT_CAP` jobs instead, for sorting and
 * filtering in the browser (ADR-044); there is no cursor then.
 */
export function useJobsList(filters: JobFilters, { full = false }: { full?: boolean } = {}) {
  const { verdict, status, needsReview, addedByYou } = filters;
  const sig = `${verdict ?? ''}|${status ?? ''}|${String(needsReview ?? false)}|${String(addedByYou ?? false)}|${full ? 'full' : 'paged'}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const current: JobFilters = {
      ...(verdict ? { verdict } : {}),
      ...(status ? { status } : {}),
      ...(needsReview ? { needsReview } : {}),
      ...(addedByYou ? { addedByYou } : {}),
    };
    const read = full
      ? loadJobsWindow(current).then((window) => ({
          jobs: window.jobs,
          invalid: window.invalid,
          cursor: null,
          capped: window.capped,
        }))
      : loadJobsPage(current).then((page) => ({
          jobs: page.jobs,
          invalid: page.invalid,
          cursor: page.cursor,
          capped: false,
        }));
    read.then(
      (result) => {
        if (!cancelled) setLoaded({ sig, ...result, failed: false });
      },
      () => {
        if (!cancelled) {
          setLoaded({ sig, jobs: [], invalid: 0, cursor: null, capped: false, failed: true });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sig, verdict, status, needsReview, addedByYou, full]);

  const loadMore = useCallback(() => {
    if (loaded?.sig !== sig || !loaded.cursor || loadingMore) return;
    setLoadingMore(true);
    loadJobsPage(
      {
        ...(verdict ? { verdict } : {}),
        ...(status ? { status } : {}),
        ...(needsReview ? { needsReview } : {}),
        ...(addedByYou ? { addedByYou } : {}),
      },
      loaded.cursor,
    ).then(
      (page) => {
        setLoaded((previous) => {
          if (previous?.sig !== sig) return previous;
          const have = new Set(previous.jobs.map((view) => view.id));
          return {
            ...previous,
            jobs: [...previous.jobs, ...page.jobs.filter((view) => !have.has(view.id))],
            invalid: previous.invalid + page.invalid,
            cursor: page.cursor,
          };
        });
        setLoadingMore(false);
      },
      () => {
        setLoadingMore(false);
      },
    );
  }, [loaded, sig, loadingMore, verdict, status, needsReview, addedByYou]);

  const patch = useCallback((view: JobView) => {
    setLoaded((previous) =>
      previous
        ? {
            ...previous,
            jobs: previous.jobs.map((item) => (item.id === view.id ? view : item)),
          }
        : previous,
    );
  }, []);

  const state: JobsListState =
    loaded?.sig !== sig
      ? { status: 'loading' }
      : loaded.failed
        ? { status: 'error', message: "Couldn't load jobs. Check your connection." }
        : {
            status: 'ready',
            jobs: loaded.jobs,
            invalid: loaded.invalid,
            more: loaded.cursor !== null,
            loadingMore,
            capped: loaded.capped,
          };
  return { state, loadMore, patch };
}

/**
 * Filter and sort loaded jobs, showing `pageSize` at a time. Derived, so an optimistic patch
 * re-sorts in place. The shown count starts over when the sort, a filter or the list's `scope`
 * (verdict, status, review) changes, not on a patch.
 */
export function useSortedJobs(
  jobs: readonly JobView[],
  sort: JobSort,
  filter: JobFilter,
  scope: string,
  pageSize: number = JOBS_PAGE_SIZE,
) {
  const { lane, gap } = filter;
  const key = `${scope}|${sort}|${lane ?? ''}|${gap ?? ''}`;
  const [shown, setShown] = useState({ key, count: pageSize });
  const count = shown.key === key ? shown.count : pageSize;
  const all = useMemo(
    () => sortJobs(filterJobs(jobs, { lane, gap }), sort),
    [jobs, sort, lane, gap],
  );
  const showMore = useCallback(() => {
    setShown({ key, count: count + pageSize });
  }, [key, count, pageSize]);
  return { jobs: all.slice(0, count), total: all.length, hasMore: all.length > count, showMore };
}

export function useAgreement(refreshKey: number): LiveState<Agreement> {
  const [state, setState] = useState<LiveState<Agreement>>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    loadAgreement(new Date()).then(
      (data) => {
        if (!cancelled) setState({ status: 'ready', data, invalid: 0 });
      },
      () => {
        if (!cancelled) setState({ status: 'error', message: "Couldn't load verdict agreement." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return state;
}
