import { CRITERIA_SEED_V1, type Verdict } from '@hireframe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Skeleton } from '@/components/ui/skeleton';
import { markOnce, signalUsable } from '@/lib/perf';
import { useCurrentCriteria } from '@/features/criteria/hooks';
import { JobDetail } from '@/features/jobs/JobDetail';
import { JobList } from '@/features/jobs/JobList';
import { VERDICT_LABELS } from '@/features/jobs/labels';
import {
  filterJobs,
  GAP_FILTERS,
  GAP_LABELS,
  SORT_LABELS,
  sortJobs,
  type GapFilter,
  type JobSort,
} from '@/features/jobs/sort';
import { FilterSelect, SortSelect } from '@/features/jobs/SortSelect';
import { TODAY_LISTS, TODAY_LIST_SIZE, type TodayListId } from '@/services/dashboard';

import { useTodayList } from './hooks';
import { SummaryBar, SummaryBarSkeleton } from './SummaryBar';
import { AddedByYou } from './AddedByYou';
import { useTodaySort } from './sortPreference';

const GAP_OPTIONS = GAP_FILTERS.map((value) => ({ value, label: GAP_LABELS[value] }));

const LIST_TITLES: Readonly<Record<TodayListId, string>> = {
  apply: 'Apply',
  near_miss: 'Near misses',
  wildcard: 'Wildcards',
};

const EMPTY_TEXT: Readonly<Record<TodayListId, string>> = {
  apply: 'Nothing to apply for right now. New matches appear after the next scan.',
  near_miss: 'No near misses waiting.',
  wildcard: 'No wildcards waiting.',
};

/** The Jobs view for a list: open jobs, in the same sort and gap. Jobs sorts up to 300 exactly. */
function seeAllPath(list: TodayListId, sort: JobSort, gap: GapFilter | ''): string {
  const params = new URLSearchParams({ verdict: list satisfies Verdict, status: 'new' });
  if (sort !== 'newest') params.set('sort', sort);
  if (gap) params.set('gap', gap);
  return `/jobs?${params.toString()}`;
}

function TodaySection({
  list,
  now,
  onOpen,
  onCommitted,
  onReady,
}: {
  list: TodayListId;
  now: Date;
  onOpen: (jobId: string) => void;
  onCommitted: () => void;
  onReady?: () => void;
}) {
  const state = useTodayList(list);
  const [sort, setSort] = useTodaySort(list);
  const [gap, setGap] = useState<GapFilter | ''>('');
  // The loaded rows only: same query, same limit, no extra reads (ADR-044).
  const loaded = state.status === 'ready' ? state.data : null;
  const rows = useMemo(
    () => (loaded ? sortJobs(filterJobs(loaded, gap ? { gap } : {}), sort) : []),
    [loaded, sort, gap],
  );
  const ready = state.status === 'ready';
  useEffect(() => {
    if (ready) onReady?.();
  }, [ready, onReady]);
  const titleId = `list-${list}`;
  return (
    <section aria-labelledby={titleId} className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id={titleId} className="text-sm font-medium">
          {LIST_TITLES[list]}
          {state.status === 'ready' && state.data.length > 0 ? (
            <span className="ml-2 font-mono text-xs text-muted-foreground tabular-nums">
              {gap
                ? `${String(rows.length)} of ${String(state.data.length)}`
                : `${String(state.data.length)}${state.data.length === TODAY_LIST_SIZE ? '+' : ''}`}
            </span>
          ) : null}
        </h2>
        {state.status === 'ready' && state.data.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            {list === 'near_miss' ? (
              <FilterSelect
                label="Gap"
                hiddenLabel={LIST_TITLES[list]}
                value={gap}
                options={GAP_OPTIONS}
                emptyLabel="Any"
                onChange={setGap}
              />
            ) : null}
            <SortSelect value={sort} hiddenLabel={LIST_TITLES[list]} onChange={setSort} />
          </div>
        ) : null}
      </div>
      <div className="mt-3">
        {state.status === 'loading' ? (
          <div role="status" aria-label={`Loading ${LIST_TITLES[list]}`} className="space-y-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : state.status === 'error' ? (
          <p role="alert" className="text-sm text-danger">
            {state.message}
          </p>
        ) : state.data.length === 0 ? (
          <p className="rounded-lg border border-dashed bg-surface px-4 py-6 text-center text-sm text-muted-foreground">
            {EMPTY_TEXT[list]}
          </p>
        ) : rows.length === 0 ? (
          <p className="rounded-lg border border-dashed bg-surface px-4 py-6 text-center text-sm text-muted-foreground">
            No {LIST_TITLES[list].toLowerCase()} with this gap in the newest {TODAY_LIST_SIZE}.
          </p>
        ) : (
          <JobList
            jobs={rows}
            label={`${LIST_TITLES[list]} jobs`}
            now={now}
            showVerdict={false}
            onOpen={onOpen}
            onCommitted={onCommitted}
            footer={
              state.data.length === TODAY_LIST_SIZE ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {sort === 'newest'
                    ? `Showing the newest ${String(TODAY_LIST_SIZE)}.`
                    : `Sorted among the newest ${String(TODAY_LIST_SIZE)}.`}{' '}
                  <Link to={seeAllPath(list, sort, gap)} className="underline underline-offset-4">
                    See all {VERDICT_LABELS[list].toLowerCase()} jobs
                    {sort === 'newest' ? '' : ` by ${SORT_LABELS[sort].toLowerCase()}`} →
                  </Link>
                </p>
              ) : null
            }
          />
        )}
      </div>
    </section>
  );
}

/**
 * Today (PRD R7): the Apply, Near miss and Wildcard lists under a summary bar. `hf:usable` marks
 * the first render with the Apply list filled; the bar and Added by you load after it (ADR-051,
 * which amends ADR-038's R7 measure).
 */
export function TodayPage() {
  const [params, setParams] = useSearchParams();
  const jobId = params.get('job');
  const [refreshKey, setRefreshKey] = useState(0);
  const criteria = useCurrentCriteria();
  const weeklyTarget =
    criteria.status === 'ready' ? criteria.criteria.weekly_target : CRITERIA_SEED_V1.weekly_target;
  const [applyReady, setApplyReady] = useState(false);
  // Set once `hf:usable` is marked; later reads (the summary bar, Added by you) start only after it.
  const [usable, setUsable] = useState(false);
  const measured = useRef(false);
  const [now] = useState(() => new Date());
  useEffect(() => {
    markOnce('hf:today-mount');
  }, []);

  const markApplyReady = useCallback(() => {
    setApplyReady(true);
  }, []);
  useEffect(() => {
    if (measured.current || !applyReady) return;
    measured.current = true;
    try {
      performance.measure('hf:usable', { start: 0, end: performance.now() });
    } catch {
      // Measuring is a convenience; Today works without it.
    }
    setUsable(true);
    // The pipeline badge in the shell starts its read only after this.
    signalUsable();
  }, [applyReady]);

  const changed = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);
  const open = useCallback(
    (id: string) => {
      setParams({ job: id });
    },
    [setParams],
  );

  return (
    <section aria-labelledby="page-title" className="mx-auto max-w-5xl">
      <h1 id="page-title" className="text-xl font-semibold tracking-tight">
        Today
      </h1>
      <div className="mt-6">
        {usable ? (
          <SummaryBar weeklyTarget={weeklyTarget} refreshKey={refreshKey} />
        ) : (
          <SummaryBarSkeleton />
        )}
      </div>
      {TODAY_LISTS.map((list) => (
        <TodaySection
          key={list}
          list={list}
          now={now}
          onOpen={open}
          onCommitted={changed}
          {...(list === 'apply' ? { onReady: markApplyReady } : {})}
        />
      ))}
      {usable ? <AddedByYou now={now} onOpen={open} onCommitted={changed} /> : null}
      {jobId ? (
        <JobDetail
          jobId={jobId}
          onClose={() => {
            setParams({});
          }}
          onCommitted={changed}
        />
      ) : null}
    </section>
  );
}
