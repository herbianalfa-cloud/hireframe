import { isRunStalled, nextScheduledRun, summaryCounts, type Run } from '@hireframe/shared';
import { CalendarClock, CircleCheck, Clock, Loader2, Send, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { Skeleton } from '@/components/ui/skeleton';
import { VERDICT_CLASSES, VERDICT_ICONS, VERDICT_LABELS } from '@/features/jobs/labels';
import { RUN_STATUS_LABELS } from '@/features/system/labels';
import type { TodayListId } from '@/services/dashboard';

import { useLastRun, useSummaryCounts } from './hooks';
import { SpendMeter } from './SpendMeter';

const WHEN_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const OPEN_LINKS: readonly { list: TodayListId; label: string }[] = [
  { list: 'apply', label: `Open ${VERDICT_LABELS.apply}` },
  { list: 'near_miss', label: `Open ${VERDICT_LABELS.near_miss.toLowerCase()}` },
  { list: 'wildcard', label: `Open ${VERDICT_LABELS.wildcard.toLowerCase()}` },
];

const ITEM = 'flex flex-col gap-1 px-4 py-3';

/** Shown until Today is usable, so the row's height doesn't jump when the numbers arrive. */
export function SummaryBarSkeleton() {
  return (
    <div role="status" aria-label="Loading numbers">
      <Skeleton className="h-20" />
    </div>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className={ITEM}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </li>
  );
}

function Unavailable() {
  return (
    <span className="flex items-baseline gap-2">
      <span className="font-mono text-2xl text-muted-foreground">–</span>
      <span className="text-xs text-danger">unavailable</span>
    </span>
  );
}

function CountLink({
  list,
  label,
  value,
}: {
  list: TodayListId;
  label: string;
  value: number | null;
}) {
  const Icon = VERDICT_ICONS[list];
  return (
    <li className="contents">
      <Link
        to={`/jobs?verdict=${list}&status=new`}
        aria-label={`${label} ${value === null ? 'unavailable' : String(value)}`}
        className="flex flex-col gap-1 px-4 py-3 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
      >
        <span className="text-xs text-muted-foreground">{label}</span>
        {value === null ? (
          <Unavailable />
        ) : (
          <span
            className={`flex items-center gap-1.5 font-mono text-2xl tabular-nums ${
              VERDICT_CLASSES[list].split(' ').find((c) => c.startsWith('text-')) ?? ''
            }`}
          >
            <Icon aria-hidden="true" className="size-5" />
            {value}
          </span>
        )}
      </Link>
    </li>
  );
}

function LastRun({ run, now }: { run: Run | null; now: Date }) {
  if (!run) return <span className="text-sm text-muted-foreground">No runs yet</span>;
  const stalled = isRunStalled(run, now);
  const Icon = stalled
    ? Clock
    : run.status === 'running'
      ? Loader2
      : run.status === 'succeeded'
        ? CircleCheck
        : TriangleAlert;
  const tone =
    stalled || run.status === 'failed'
      ? 'text-danger'
      : run.status === 'partial'
        ? 'text-verdict-near-miss'
        : '';
  return (
    <span className="text-sm">
      {WHEN_FORMAT.format(run.startedAt)}
      <span className={`ml-2 inline-flex items-center gap-1 ${tone}`}>
        <Icon
          aria-hidden="true"
          className={`size-3.5 ${!stalled && run.status === 'running' ? 'animate-spin' : ''}`}
        />
        {stalled ? 'Timed out' : RUN_STATUS_LABELS[run.status]}
      </span>
    </span>
  );
}

/**
 * Today's summary bar (ADR-051): open Apply, near miss and wildcard counts, applied this week,
 * the last and next scan, and the month's spend. It replaces the four tiles and mounts only after
 * `hf:usable`, so none of its reads is on the critical path. Every item has a label and a
 * number or icon, never colour alone. "Things to do" arrives with the pipeline (M7D).
 */
export function SummaryBar({
  weeklyTarget,
  refreshKey,
}: {
  weeklyTarget: number;
  refreshKey: number;
}) {
  const state = useSummaryCounts(refreshKey);
  const lastRun = useLastRun();
  const [now] = useState(() => new Date());
  const [next] = useState(() => nextScheduledRun(now));
  if (state.status === 'loading') return <SummaryBarSkeleton />;
  const summary = summaryCounts(state.counts, weeklyTarget);
  const values: Record<TodayListId, number | null> = {
    apply: summary.apply,
    near_miss: summary.nearMiss,
    wildcard: summary.wildcard,
  };
  return (
    <section aria-label="Summary" className="rounded-lg border bg-surface">
      <ul className="grid grid-cols-2 divide-x divide-y lg:grid-cols-4 [&>*]:min-w-0">
        {OPEN_LINKS.map(({ list, label }) => (
          <CountLink key={list} list={list} label={label} value={values[list]} />
        ))}
        <Item label="Applied this week">
          {summary.appliedThisWeek === null ? (
            <Unavailable />
          ) : (
            <>
              <span className="flex items-center gap-1.5 font-mono text-2xl tabular-nums">
                <Send aria-hidden="true" className="size-5" />
                {summary.appliedThisWeek}
                <span className="text-sm text-muted-foreground"> / {weeklyTarget}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {summary.weeklyMet ? 'Target met' : `${String(summary.weeklyRemaining ?? 0)} to go`}
              </span>
            </>
          )}
        </Item>
        <Item label="Last run">
          {lastRun.status === 'loading' ? (
            <Skeleton role="status" aria-label="Loading last run" className="h-6" />
          ) : lastRun.status === 'error' ? (
            <span className="text-sm text-muted-foreground">Unavailable</span>
          ) : (
            <LastRun run={lastRun.data} now={now} />
          )}
        </Item>
        <Item label="Next run">
          <span className="flex items-center gap-1.5 text-sm">
            <CalendarClock aria-hidden="true" className="size-4" />
            {WHEN_FORMAT.format(next)}
          </span>
        </Item>
        <Item label="AI spend this month">
          <Link
            to="/system"
            className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <SpendMeter compact />
          </Link>
        </Item>
      </ul>
    </section>
  );
}
