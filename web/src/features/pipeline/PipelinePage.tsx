import { PIPELINE_STAGES, STAGE_PAGE_SIZE, type PipelineStage } from '@/services/applications';
import { Link } from 'react-router';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useCvHeader } from '@/features/profile/hooks';
import type { ApplicationView } from '@/services/applications';
import type { LiveState } from '@/services/profile';

import { ApplicationCard } from './ApplicationCard';
import { useAppliedThisWeek, useStage } from './hooks';
import { STAGE_META } from './labels';

/** "n", "20+" when the read was full, "–" while loading or failed. */
function countText(state: LiveState<ApplicationView[]>): string {
  if (state.status !== 'ready') return '–';
  const n = state.data.length;
  return n >= STAGE_PAGE_SIZE ? `${String(STAGE_PAGE_SIZE)}+` : String(n);
}

function StageTile({
  stage,
  label,
  value,
}: {
  stage: PipelineStage;
  label: string;
  value: string | null;
}) {
  const meta = STAGE_META[stage];
  return (
    <li className="rounded-lg border bg-surface p-3">
      <p className={cn('flex items-center gap-1.5 text-xs font-medium', meta.text)}>
        <meta.Icon aria-hidden="true" className="size-4 shrink-0" />
        {label}
      </p>
      <p className="mt-1 font-mono text-xl tabular-nums">
        {value ?? <Skeleton className="h-7 w-8" />}
      </p>
    </li>
  );
}

function StageSection({
  stage,
  state,
  headerName,
}: {
  stage: PipelineStage;
  state: LiveState<ApplicationView[]>;
  headerName: string | undefined;
}) {
  const meta = STAGE_META[stage];
  const headingId = `stage-${stage}`;
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className={cn('flex items-center gap-2 text-sm font-medium', meta.text)}>
        <meta.Icon aria-hidden="true" className="size-4 shrink-0" />
        {meta.label}
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {countText(state)}
        </span>
      </h2>
      <div className="mt-2">
        {state.status === 'loading' ? (
          <div role="status" aria-label={`Loading ${meta.label}`} className="space-y-2">
            <Skeleton className="h-20" />
          </div>
        ) : state.status === 'error' ? (
          <p role="alert" className="text-sm text-danger">
            {state.message}
          </p>
        ) : state.data.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
            {meta.empty}
          </p>
        ) : (
          <>
            <ul className="space-y-3">
              {state.data.map((view) => (
                <ApplicationCard key={view.id} view={view} stage={stage} headerName={headerName} />
              ))}
            </ul>
            {state.invalid > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {state.invalid} application{state.invalid === 1 ? '' : 's'} couldn&apos;t be read
                and {state.invalid === 1 ? 'is' : 'are'} not shown.
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Pipeline (PRD R7, R10): every application by stage, live. The stage machine runs on the
 * server; this screen only asks it to move (answer, skip, retry, regenerate, withdraw). Mark
 * applied stays on the job.
 */
export function PipelinePage() {
  const chosen = useStage('chosen');
  const needsInput = useStage('needs_input');
  const generating = useStage('generating');
  const ready = useStage('ready');
  const applied = useStage('applied');
  const appliedWeek = useAppliedThisWeek();
  const header = useCvHeader();
  const states: Record<PipelineStage, LiveState<ApplicationView[]>> = {
    chosen,
    needs_input: needsInput,
    generating,
    ready,
    applied,
  };
  const headerName =
    header.status === 'ready' ? (header.data?.header?.name ?? undefined) : undefined;
  const allEmpty = PIPELINE_STAGES.every(
    (stage) => states[stage].status === 'ready' && states[stage].data.length === 0,
  );

  return (
    <section aria-labelledby="page-title" className="mx-auto max-w-5xl">
      <h1 id="page-title" className="text-xl font-semibold tracking-tight">
        Pipeline
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Applications you started, from a CV being written to ready to send.
      </p>
      <ul aria-label="Stage counts" className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        {PIPELINE_STAGES.map((stage) => (
          <StageTile
            key={stage}
            stage={stage}
            label={stage === 'applied' ? 'Applied this week' : STAGE_META[stage].label}
            value={
              stage === 'applied'
                ? appliedWeek.status === 'loading'
                  ? null
                  : appliedWeek.count === null
                    ? '–'
                    : String(appliedWeek.count)
                : states[stage].status === 'loading'
                  ? null
                  : countText(states[stage])
            }
          />
        ))}
      </ul>
      {allEmpty ? (
        <div className="mt-6 flex flex-col items-center rounded-lg border border-dashed bg-surface px-6 py-12 text-center">
          <h2 className="text-sm font-medium">No applications yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Open a job and choose Start application. A CV and cover note are written from your
            profile facts, and they land here.
          </p>
          <Link to="/jobs" className="mt-3 inline-flex min-h-11 items-center text-sm underline">
            Go to Jobs
          </Link>
        </div>
      ) : null}
      <div className="mt-6 space-y-8">
        {PIPELINE_STAGES.map((stage) => (
          <StageSection key={stage} stage={stage} state={states[stage]} headerName={headerName} />
        ))}
      </div>
    </section>
  );
}
