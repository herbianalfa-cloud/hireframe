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

import { AgreementLine } from './AgreementLine';
import { useJobsList } from './hooks';
import { JobDetail } from './JobDetail';
import { JobList } from './JobList';
import { STATUS_LABELS, VERDICT_LABELS } from './labels';

const isVerdict = (value: string | null): value is Verdict =>
  value !== null && (VERDICTS as readonly string[]).includes(value);
const isStatus = (value: string | null): value is ClientJobStatus =>
  value !== null && (CLIENT_JOB_STATUSES as readonly string[]).includes(value);

const SELECT_CLASS = 'h-11 rounded-md border bg-background px-3 text-sm';

/**
 * Jobs (PRD R7): every judged job, newest first, filtered by verdict and status, or just the
 * ones waiting for review. Filters live in the URL so a view can be reloaded or linked. "Needs
 * review" stands alone: it has no index combined with the others (ADR-038).
 */
export function JobsPage() {
  const [params, setParams] = useSearchParams();
  const verdictParam = params.get('verdict');
  const statusParam = params.get('status');
  const needsReview = params.get('review') === '1';
  const verdict = !needsReview && isVerdict(verdictParam) ? verdictParam : undefined;
  const status = !needsReview && isStatus(statusParam) ? statusParam : undefined;
  const jobId = params.get('job');

  // Bumped when a write is confirmed, to re-read the agreement line (the list is patched, not reloaded).
  const [statsKey, setStatsKey] = useState(0);
  const { state, loadMore, patch } = useJobsList({
    ...(verdict ? { verdict } : {}),
    ...(status ? { status } : {}),
    ...(needsReview ? { needsReview } : {}),
  });
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
  const filtered = verdict !== undefined || status !== undefined || needsReview;

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
              update({ verdict: event.target.value });
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
              update({ verdict: null, status: null, review: null });
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
        ) : state.jobs.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-surface px-6 py-12 text-center">
            <h2 className="text-sm font-medium">
              {filtered ? 'No jobs match these filters' : 'No judged jobs yet'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {filtered
                ? 'Clear the filters to see everything.'
                : 'Jobs appear here once a scan has judged them. Run Scan now on System.'}
            </p>
          </div>
        ) : (
          <>
            {state.invalid > 0 ? (
              <p className="mb-2 text-xs text-muted-foreground">
                {state.invalid} job{state.invalid === 1 ? '' : 's'} couldn&apos;t be read and{' '}
                {state.invalid === 1 ? 'was' : 'were'} left out.
              </p>
            ) : null}
            <JobList
              jobs={state.jobs}
              label="Jobs"
              now={now}
              onOpen={open}
              onPatch={patch}
              onCommitted={committed}
              footer={
                state.more ? (
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
