import type { Agreement } from '@hireframe/shared';
import type { JobDescription } from '@hireframe/shared';
import { useCallback, useEffect, useState } from 'react';

import {
  loadJobDescription,
  loadJobsPage,
  watchJob,
  type JobFilters,
  type JobsPage,
  type JobView,
} from '@/services/jobs';
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
  | { status: 'ready'; jobs: JobView[]; invalid: number; more: boolean; loadingMore: boolean };

interface Loaded {
  /** The filters this result is for; a result for other filters counts as loading. */
  sig: string;
  jobs: JobView[];
  invalid: number;
  cursor: JobsPage['cursor'];
  failed: boolean;
}

/**
 * Pages of jobs for a filter set. Changing the filters starts over. An action never reloads:
 * `patch` swaps one job in place, so loaded pages, scroll and focus stay as they are.
 */
export function useJobsList(filters: JobFilters) {
  const { verdict, status, needsReview } = filters;
  const sig = `${verdict ?? ''}|${status ?? ''}|${String(needsReview ?? false)}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const current: JobFilters = {
      ...(verdict ? { verdict } : {}),
      ...(status ? { status } : {}),
      ...(needsReview ? { needsReview } : {}),
    };
    loadJobsPage(current).then(
      (page) => {
        if (cancelled) return;
        setLoaded({
          sig,
          jobs: page.jobs,
          invalid: page.invalid,
          cursor: page.cursor,
          failed: false,
        });
      },
      () => {
        if (!cancelled) setLoaded({ sig, jobs: [], invalid: 0, cursor: null, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sig, verdict, status, needsReview]);

  const loadMore = useCallback(() => {
    if (loaded?.sig !== sig || !loaded.cursor || loadingMore) return;
    setLoadingMore(true);
    loadJobsPage(
      {
        ...(verdict ? { verdict } : {}),
        ...(status ? { status } : {}),
        ...(needsReview ? { needsReview } : {}),
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
  }, [loaded, sig, loadingMore, verdict, status, needsReview]);

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
          };
  return { state, loadMore, patch };
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
