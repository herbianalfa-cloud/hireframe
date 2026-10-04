import { CRITERIA_SEED_V1, todayKpis, type Verdict } from '@hireframe/shared';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentCriteria } from '@/features/criteria/hooks';
import { JobDetail } from '@/features/jobs/JobDetail';
import { JobList } from '@/features/jobs/JobList';
import { VERDICT_LABELS } from '@/features/jobs/labels';
import { TODAY_LISTS, TODAY_LIST_SIZE, type TodayListId } from '@/services/dashboard';

import { useTodayKpis, useTodayList, type KpiState } from './hooks';
import { SpendMeter } from './SpendMeter';

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

function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-surface p-4">
      <h2 className="text-xs text-muted-foreground">{label}</h2>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Count({ value }: { value: number }) {
  return <p className="font-mono text-2xl tabular-nums">{value}</p>;
}

function Tiles({ state, weeklyTarget }: { state: KpiState; weeklyTarget: number }) {
  const counts = state.status === 'ready' ? todayKpis(state.counts, weeklyTarget) : null;
  const pending = (
    <div role="status" aria-label="Loading numbers">
      <Skeleton className="h-12" />
    </div>
  );
  /** One tile's body: a skeleton while loading, a dash and a note if its own read failed. */
  const body = (value: number | null | undefined, render: (value: number) => ReactNode) => {
    if (!counts) return pending;
    if (value === null || value === undefined) {
      return (
        <div role="alert">
          <p className="font-mono text-2xl text-muted-foreground">–</p>
          <p className="mt-1 text-xs text-danger">Couldn&apos;t load this number.</p>
        </div>
      );
    }
    return render(value);
  };
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile label="To apply">
        {body(counts?.toApply, (value) => (
          <>
            <Count value={value} />
            <p className="mt-1 text-xs text-muted-foreground">
              {counts?.judgedToday === null || counts?.judgedToday === undefined
                ? 'judged today: unavailable'
                : `${String(counts.judgedToday)} judged today`}
            </p>
          </>
        ))}
      </Tile>
      <Tile label="To review">
        {body(counts?.toReview, (value) => (
          <>
            <Count value={value} />
            <p className="mt-1 text-xs text-muted-foreground">near misses and wildcards</p>
          </>
        ))}
      </Tile>
      <Tile label="Applied this week">
        {body(counts?.appliedThisWeek, (value) => (
          <>
            <p className="font-mono text-2xl tabular-nums">
              {value}
              <span className="text-sm text-muted-foreground"> / {weeklyTarget}</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {counts?.weeklyMet ? 'Target met' : `${String(counts?.weeklyRemaining ?? 0)} to go`}
            </p>
          </>
        ))}
      </Tile>
      <Tile label="AI spend this month">
        <SpendMeter />
      </Tile>
    </div>
  );
}

function TodaySection({
  list,
  now,
  onOpen,
  onChanged,
  onReady,
}: {
  list: TodayListId;
  now: Date;
  onOpen: (jobId: string) => void;
  onChanged: () => void;
  onReady?: () => void;
}) {
  const state = useTodayList(list);
  const ready = state.status === 'ready';
  useEffect(() => {
    if (ready) onReady?.();
  }, [ready, onReady]);
  const titleId = `list-${list}`;
  return (
    <section aria-labelledby={titleId} className="mt-8">
      <h2 id={titleId} className="text-sm font-medium">
        {LIST_TITLES[list]}
        {state.status === 'ready' && state.data.length > 0 ? (
          <span className="ml-2 font-mono text-xs text-muted-foreground tabular-nums">
            {state.data.length}
            {state.data.length === TODAY_LIST_SIZE ? '+' : ''}
          </span>
        ) : null}
      </h2>
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
        ) : (
          <JobList
            jobs={state.data}
            label={`${LIST_TITLES[list]} jobs`}
            now={now}
            showVerdict={false}
            onOpen={onOpen}
            onChanged={onChanged}
            footer={
              state.data.length === TODAY_LIST_SIZE ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing the newest {TODAY_LIST_SIZE}.{' '}
                  <Link
                    to={`/jobs?verdict=${list satisfies Verdict}`}
                    className="underline underline-offset-4"
                  >
                    See all {VERDICT_LABELS[list].toLowerCase()} jobs
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
 * Today (PRD R7): four tiles, then the Apply, Near miss and Wildcard lists. `hf:usable` marks
 * the first render with the tiles' numbers and the Apply list filled (ADR-038, R7 measure).
 */
export function TodayPage() {
  const [params, setParams] = useSearchParams();
  const jobId = params.get('job');
  const [refreshKey, setRefreshKey] = useState(0);
  const criteria = useCurrentCriteria();
  const weeklyTarget =
    criteria.status === 'ready' ? criteria.criteria.weekly_target : CRITERIA_SEED_V1.weekly_target;
  const kpis = useTodayKpis(refreshKey);
  const [applyReady, setApplyReady] = useState(false);
  const measured = useRef(false);
  const [now] = useState(() => new Date());

  const markApplyReady = useCallback(() => {
    setApplyReady(true);
  }, []);
  useEffect(() => {
    if (measured.current || kpis.status !== 'ready' || !applyReady) return;
    measured.current = true;
    try {
      performance.measure('hf:usable', { start: 0, end: performance.now() });
    } catch {
      // Measuring is a convenience; Today works without it.
    }
  }, [kpis.status, applyReady]);

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
        <Tiles state={kpis} weeklyTarget={weeklyTarget} />
      </div>
      {TODAY_LISTS.map((list) => (
        <TodaySection
          key={list}
          list={list}
          now={now}
          onOpen={open}
          onChanged={changed}
          {...(list === 'apply' ? { onReady: markApplyReady } : {})}
        />
      ))}
      {jobId ? (
        <JobDetail
          jobId={jobId}
          onClose={() => {
            setParams({});
          }}
          onChanged={changed}
        />
      ) : null}
    </section>
  );
}
