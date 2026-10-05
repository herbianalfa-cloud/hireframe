import {
  CLIENT_JOB_STATUSES,
  VERDICTS,
  type ClientJobStatus,
  type Verdict,
} from '@hireframe/shared';
import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { JOBS_SORT_CAP } from '@/services/jobs';

import { AgreementLine } from './AgreementLine';
import { useJobsList, useSortedJobs } from './hooks';
import { JobDetail } from './JobDetail';
import { JobList } from './JobList';
import { STATUS_LABELS, VERDICT_LABELS } from './labels';
import {
  GAP_FILTERS,
  GAP_LABELS,
  isGapFilter,
  isJobSort,
  isLaneFilter,
  LANE_FILTERS,
  LANE_LABELS,
} from './sort';
import { FilterSelect, SELECT_CLASS, SortSelect } from './SortSelect';

const isVerdict = (value: string | null): value is Verdict =>
  value !== null && (VERDICTS as readonly string[]).includes(value);
const isStatus = (value: string | null): value is ClientJobStatus =>
  value !== null && (CLIENT_JOB_STATUSES as readonly string[]).includes(value);

const LANE_OPTIONS = LANE_FILTERS.map((value) => ({ value, label: LANE_LABELS[value] }));
const GAP_OPTIONS = GAP_FILTERS.map((value) => ({ value, label: GAP_LABELS[value] }));

/**
 * Jobs (PRD R7): every judged job, filtered by verdict and status, or just the ones waiting for
 * review. Newest first pages from Firestore; any other sort, or a lane or gap filter, reads the
 * newest 300 once and sorts and filters in the browser (ADR-044). Filters live in the URL so a
 * view can be reloaded or linked. "Needs review" stands alone: it has no index combined with the
 * others (ADR-038), so it also turns the browser-side controls off.
 */
export function JobsPage() {
  const [params, setParams] = useSearchParams();
  const verdictParam = params.get('verdict');
  const statusParam = params.get('status');
  const needsReview = params.get('review') === '1';
  const verdict = !needsReview && isVerdict(verdictParam) ? verdictParam : undefined;
  const status = !needsReview && isStatus(statusParam) ? statusParam : undefined;
  const sortParam = params.get('sort');
  const laneParam = params.get('lane');
  const gapParam = params.get('gap');
  const sort = !needsReview && isJobSort(sortParam) ? sortParam : 'newest';
  const lane = !needsReview && isLaneFilter(laneParam) ? laneParam : undefined;
  // Gap filters near misses, so it only applies while that verdict is chosen.
  const gap =
    !needsReview && verdict === 'near_miss' && isGapFilter(gapParam) ? gapParam : undefined;
  const full = sort !== 'newest' || lane !== undefined || gap !== undefined;
  const jobId = params.get('job');

  // Bumped when a write is confirmed, to re-read the agreement line (the list is patched, not reloaded).
  const [statsKey, setStatsKey] = useState(0);
  const { state, loadMore, patch } = useJobsList(
    {
      ...(verdict ? { verdict } : {}),
      ...(status ? { status } : {}),
      ...(needsReview ? { needsReview } : {}),
    },
    { full },
  );
  const sorted = useSortedJobs(
    state.status === 'ready' ? state.jobs : [],
    sort,
    { lane, gap },
    `${verdict ?? ''}|${status ?? ''}|${String(needsReview)}`,
  );
  const [now] = useState(() => new Date());

  const update = useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(params);
      next.delete('job');
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      setParams(next);
    },
    [params, setParams],
  );
  const committed = useCallback(() => {
    setStatsKey((key) => key + 1);
  }, []);
  const open = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params);
      next.set('job', id);
      setParams(next);
    },
    [params, setParams],
  );
  const filtered =
    verdict !== undefined ||
    status !== undefined ||
    needsReview ||
    lane !== undefined ||
    gap !== undefined;
  const shownJobs = state.status === 'ready' ? (full ? sorted.jobs : state.jobs) : [];

  return (
    <section aria-labelledby="page-title" className="mx-auto max-w-5xl">
      <h1 id="page-title" className="text-xl font-semibold tracking-tight">
        Jobs
      </h1>
      <div className="mt-2">
        <AgreementLine refreshKey={statsKey} />
      </div>
      <form
        aria-label="Filters"
        className="mt-4 flex flex-wrap items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className="flex items-center gap-2 text-sm">
          Verdict
          <select
            value={verdict ?? ''}
            disabled={needsReview}
            onChange={(event) => {
              // Gap belongs to near misses only.
              update({
                verdict: event.target.value,
                ...(event.target.value === 'near_miss' ? {} : { gap: null }),
              });
            }}
            className={SELECT_CLASS}
          >
            <option value="">All</option>
            {VERDICTS.map((item) => (
              <option key={item} value={item}>
                {VERDICT_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          Status
          <select
            value={status ?? ''}
            disabled={needsReview}
            onChange={(event) => {
              update({ status: event.target.value });
            }}
            className={SELECT_CLASS}
          >
            <option value="">All</option>
            {CLIENT_JOB_STATUSES.map((item) => (
              <option key={item} value={item}>
                {STATUS_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        {verdict === 'near_miss' ? (
          <FilterSelect
            label="Gap"
            value={gap ?? ''}
            options={GAP_OPTIONS}
            emptyLabel="Any"
            disabled={needsReview}
            onChange={(value) => {
              update({ gap: value });
            }}
          />
        ) : null}
        <FilterSelect
          label="Lane"
          value={lane ?? ''}
          options={LANE_OPTIONS}
          emptyLabel="All"
          disabled={needsReview}
          onChange={(value) => {
            update({ lane: value });
          }}
        />
        <SortSelect
          value={sort}
          disabled={needsReview}
          onChange={(value) => {
            update({ sort: value === 'newest' ? null : value });
          }}
        />
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={needsReview}
            onChange={(event) => {
              update({ review: event.target.checked ? '1' : null, verdict: null, status: null });
            }}
            className="size-4"
          />
          Needs review
        </label>
        {filtered ? (
          <Button
            variant="ghost"
            onClick={() => {
              update({ verdict: null, status: null, review: null, lane: null, gap: null });
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </form>

      <div className="mt-4">
        {state.status === 'loading' ? (
          <div role="status" aria-label="Loading jobs" className="space-y-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : state.status === 'error' ? (
          <p role="alert" className="text-sm text-danger">
            {state.message}
          </p>
        ) : shownJobs.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-surface px-6 py-12 text-center">
            <h2 className="text-sm font-medium">
              {filtered ? 'No jobs match these filters' : 'No judged jobs yet'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {filtered
                ? 'Clear the filters to see everything.'
                : 'Jobs appear here once a scan has judged them. Run Scan now on System.'}
            </p>
            {state.capped ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Only the newest {JOBS_SORT_CAP} jobs for this verdict and status were read, so older
                jobs that fit your sort or filters aren&apos;t shown.
              </p>
            ) : null}
          </div>
        ) : (
          <>
            {state.invalid > 0 ? (
              <p className="mb-2 text-xs text-muted-foreground">
                {state.invalid} job{state.invalid === 1 ? '' : 's'} couldn&apos;t be read and{' '}
                {state.invalid === 1 ? 'was' : 'were'} left out.
              </p>
            ) : null}
            {state.capped ? (
              <p className="mb-2 text-xs text-muted-foreground">
                Only the newest {JOBS_SORT_CAP} jobs for this verdict and status were read, so older
                jobs that fit your sort or filters aren&apos;t shown.
              </p>
            ) : null}
            <JobList
              jobs={shownJobs}
              label="Jobs"
              now={now}
              onOpen={open}
              onPatch={patch}
              onCommitted={committed}
              footer={
                full ? (
                  sorted.hasMore ? (
                    <Button variant="secondary" className="mt-3 w-full" onClick={sorted.showMore}>
                      Show more
                    </Button>
                  ) : null
                ) : state.more ? (
                  <Button
                    variant="secondary"
                    className="mt-3 w-full"
                    disabled={state.loadingMore}
                    onClick={loadMore}
                  >
                    {state.loadingMore ? 'Loading…' : 'Load more'}
                  </Button>
                ) : null
              }
            />
          </>
        )}
      </div>
      {jobId ? (
        <JobDetail
          jobId={jobId}
          onClose={() => {
            update({ job: null });
          }}
          onPatch={patch}
          onCommitted={committed}
        />
      ) : null}
    </section>
  );
}
