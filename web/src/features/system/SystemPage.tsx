import { isRunStalled, type SourceStatus } from '@hireframe/shared';
import {
  Ban,
  CircleAlert,
  Clock,
  CircleCheck,
  CircleMinus,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  scanErrorMessage,
  scanNow,
  type BoardView,
  type RunView,
  type SourceView,
} from '@/services/system';

import { useBrokenBoards, useJobCount, useRecentRuns, useSources } from './hooks';
import {
  errorText,
  funnelText,
  rescoreText,
  RUN_STATUS_LABELS,
  RUN_TRIGGER_LABELS,
  scanResultText,
  SOURCE_LABELS,
  SOURCE_STATUS_LABELS,
  STOP_TEXT,
} from './labels';

const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function StatusBadge({ status }: { status: SourceStatus }) {
  const label = SOURCE_STATUS_LABELS[status];
  if (status === 'ok') {
    return (
      <Badge variant="success">
        <CircleCheck aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  if (status === 'degraded') {
    return (
      <Badge variant="warning">
        <TriangleAlert aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  if (status === 'failing') {
    return (
      <Badge variant="danger">
        <CircleAlert aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  return (
    <Badge>
      {status === 'disabled' ? <Ban aria-hidden="true" /> : <CircleMinus aria-hidden="true" />}
      {label}
    </Badge>
  );
}

function ScanNowCard({ onFinished }: { onFinished: () => void }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean }>();

  async function run() {
    setPending(true);
    setMessage(undefined);
    try {
      const result = await scanNow();
      setMessage({ text: scanResultText(result, new Date()), error: false });
      onFinished();
    } catch (caught) {
      setMessage({ text: scanErrorMessage(caught), error: true });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-6 rounded-lg border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Scan now</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Fetches every source and adds new jobs. Verdicts arrive with the funnel (M4).
          </p>
        </div>
        <Button
          disabled={pending}
          className="min-h-11"
          onClick={() => {
            void run();
          }}
        >
          {pending ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
          {pending ? 'Scanning…' : 'Scan now'}
        </Button>
      </div>
      <div aria-live="polite" className="text-sm">
        {pending ? (
          <p className="mt-3 text-muted-foreground">
            This can take a few minutes. It keeps running if you leave this page.
          </p>
        ) : null}
        {message ? (
          <p className={`mt-3 ${message.error ? 'text-danger' : ''}`}>{message.text}</p>
        ) : null}
      </div>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm tabular-nums">{value}</dd>
    </div>
  );
}

/** The latest time a host of this source asked us to stay away until, if still ahead. */
function pausedUntil(view: SourceView, now: Date): Date | null {
  const ahead = (view.health.pausedHosts ?? [])
    .map((pause) => pause.until)
    .filter((until) => until.getTime() > now.getTime());
  return ahead.length ? new Date(Math.max(...ahead.map((until) => until.getTime()))) : null;
}

function SourceCard({ view }: { view: SourceView }) {
  const { health } = view;
  const counts = health.lastCounts;
  const reason = errorText(health.lastErrorCode);
  const paused = pausedUntil(view, new Date());
  return (
    <li className="rounded-lg border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{SOURCE_LABELS[view.id]}</h3>
        <StatusBadge status={health.status} />
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
        <Count label="Fetched" value={counts.fetched} />
        <Count label="New" value={counts.new} />
        <Count label="Merged" value={counts.merged} />
        <Count label="Known" value={counts.duplicate} />
        <Count label="Errors" value={counts.errors} />
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        Last run {TIME_FORMAT.format(health.lastRunAt)}
        {health.lastOkAt ? ` · last OK ${TIME_FORMAT.format(health.lastOkAt)}` : ' · never OK'}
        {health.quota ? ` · ${String(health.quota.dayCount)} API calls today` : ''}
      </p>
      {paused ? (
        <p className="mt-1 flex items-center gap-1 text-xs text-verdict-near-miss">
          <Clock aria-hidden="true" className="size-3" />
          Paused until {TIME_FORMAT.format(paused)}: the site asked us to slow down, so scans skip
          it until then.
        </p>
      ) : null}
      {health.status !== 'ok' && reason ? (
        <p className="mt-1 text-xs text-muted-foreground">Why: {reason}</p>
      ) : null}
      {view.id === 'adzuna' ? (
        <p className="mt-1 text-xs text-muted-foreground">
          <a
            href="https://www.adzuna.co.uk"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4"
          >
            Jobs by Adzuna
          </a>
        </p>
      ) : null}
    </li>
  );
}

function Sources() {
  const state = useSources();
  if (state.status === 'loading') {
    return (
      <div role="status" aria-label="Loading sources" className="mt-3 space-y-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <p role="alert" className="mt-3 text-sm text-danger">
        {state.message}
      </p>
    );
  }
  if (state.data.length === 0) {
    return <p className="mt-3 text-sm text-muted-foreground">No scans yet. Run Scan now.</p>;
  }
  return (
    <ul className="mt-3 grid gap-3 md:grid-cols-2">
      {state.data.map((view) => (
        <SourceCard key={view.id} view={view} />
      ))}
    </ul>
  );
}

function BrokenBoards() {
  const state = useBrokenBoards();
  if (state.status === 'error') {
    return (
      <p role="alert" className="mt-8 text-sm text-danger">
        {state.message}
      </p>
    );
  }
  if (state.status !== 'ready' || state.data.length === 0) return null;
  const boards: BoardView[] = state.data;
  return (
    <section aria-labelledby="broken-title" className="mt-8">
      <h2 id="broken-title" className="text-sm font-medium">
        Broken job boards
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        These boards have been missing for several scans. Check the company&apos;s careers page and
        fix its board token, or set <code className="font-mono">watch</code> to false.
      </p>
      <ul className="mt-3 divide-y rounded-lg border bg-surface">
        {boards.map(({ id, company }) => (
          <li key={id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <span className="text-sm">{company.name}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {company.ats.type}:{company.ats.token ?? ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function runSummary(view: RunView, stalled: boolean): string {
  const { s0, rescore } = view.run.perStage;
  if (stalled) return 'Stopped before it finished';
  if (rescore) return rescoreText(rescore);
  if (!s0) return view.run.status === 'running' ? 'In progress' : 'No jobs processed';
  return `${String(s0.new)} new · ${String(s0.merged)} merged · ${String(s0.duplicate)} known`;
}

/** Spend warnings and why the AI stages stopped early (PRD R11, ADR-032). */
function RunNotes({ view }: { view: RunView }) {
  const { flags = [], budget } = view.run;
  const stoppedBy = budget?.stoppedBy;
  if (flags.length === 0 && !stoppedBy) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {flags.includes('spend_80') ? (
        <Badge variant="warning">
          <TriangleAlert aria-hidden="true" />
          80% of the monthly AI cap used
        </Badge>
      ) : null}
      {flags.includes('deep_pause') ? (
        <Badge variant="warning">
          <CircleMinus aria-hidden="true" />
          Deep reads paused
        </Badge>
      ) : null}
      {stoppedBy && stoppedBy !== 'deep_pause' ? (
        <span>Stopped early: {STOP_TEXT[stoppedBy]}.</span>
      ) : null}
    </p>
  );
}

function RunBadge({ view, stalled }: { view: RunView; stalled: boolean }) {
  // A run killed before it could record its end (callable timeout) shows as timed out at once;
  // the next scan marks it failed in Firestore (ADR-029).
  if (stalled) {
    return (
      <Badge variant="danger">
        <Clock aria-hidden="true" />
        Timed out
      </Badge>
    );
  }
  const { status } = view.run;
  return (
    <Badge
      variant={
        status === 'succeeded'
          ? 'success'
          : status === 'running'
            ? 'accent'
            : status === 'partial'
              ? 'warning'
              : 'danger'
      }
    >
      {status === 'running' ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
      {RUN_STATUS_LABELS[status]}
    </Badge>
  );
}

function RecentRuns() {
  const state = useRecentRuns();
  if (state.status === 'loading') {
    return (
      <div role="status" aria-label="Loading runs" className="mt-3">
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <p role="alert" className="mt-3 text-sm text-danger">
        {state.message}
      </p>
    );
  }
  if (state.data.length === 0) return null;
  const now = new Date();
  return (
    <ul className="mt-3 divide-y rounded-lg border bg-surface">
      {state.data.map((view) => {
        const stalled = isRunStalled(view.run, now);
        const funnel = funnelText(view.run);
        return (
          <li key={view.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">
                {TIME_FORMAT.format(view.run.startedAt)}{' '}
                <span className="text-muted-foreground">
                  · {RUN_TRIGGER_LABELS[view.run.trigger]} · {runSummary(view, stalled)}
                </span>
              </span>
              <RunBadge view={view} stalled={stalled} />
            </div>
            {funnel ? <p className="mt-1 text-xs text-muted-foreground">{funnel}</p> : null}
            <RunNotes view={view} />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * System (PRD R12): Scan now, source health and recent runs (M3, ADR-029), with each run's
 * funnel counts per stage, cost and spend warnings (M4). The spend meter and error alerts
 * arrive in M5.
 */
export function SystemPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const jobCount = useJobCount(refreshKey);
  return (
    <section aria-labelledby="page-title" className="mx-auto max-w-5xl">
      <h1 id="page-title" className="text-xl font-semibold tracking-tight">
        System
      </h1>
      <ScanNowCard
        onFinished={() => {
          setRefreshKey((key) => key + 1);
        }}
      />
      <p className="mt-4 text-sm text-muted-foreground">
        {jobCount === null ? 'Jobs stored: …' : `Jobs stored: ${String(jobCount)}`}
      </p>
      <section aria-labelledby="sources-title" className="mt-8">
        <h2 id="sources-title" className="text-sm font-medium">
          Sources
        </h2>
        <Sources />
      </section>
      <BrokenBoards />
      <section aria-labelledby="runs-title" className="mt-8">
        <h2 id="runs-title" className="text-sm font-medium">
          Recent runs
        </h2>
        <RecentRuns />
      </section>
    </section>
  );
}
