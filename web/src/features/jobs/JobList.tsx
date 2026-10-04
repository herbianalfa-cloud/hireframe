import { useCallback, useState, type ReactNode } from 'react';

import { jobActionErrorMessage, setJobStatus, type JobView } from '@/services/jobs';

import { ageText, scoreText } from './labels';
import { SourceAttribution } from './AdzunaAttribution';
import { useListKeys } from './useListKeys';
import { VerdictBadge } from './VerdictBadge';

function JobRow({
  view,
  now,
  showVerdict,
  onOpen,
}: {
  view: JobView;
  now: Date;
  showVerdict: boolean;
  onOpen: (jobId: string) => void;
}) {
  const { job } = view;
  const hasAttribution = job.sources.some((s) => s.id === 'adzuna' || s.id === 'reed');
  return (
    <li>
      <button
        type="button"
        data-job-row
        data-job-id={view.id}
        onClick={() => {
          onOpen(view.id);
        }}
        className="flex min-h-11 w-full flex-col gap-1 rounded-md px-4 py-3 text-left transition-colors duration-150 ease-out hover:bg-surface-raised"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-sm font-medium">{job.title}</span>
          {showVerdict && job.verdict ? <VerdictBadge verdict={job.verdict} /> : null}
          {job.status !== 'new' ? (
            <span className="text-xs text-muted-foreground capitalize">{job.status}</span>
          ) : null}
        </span>
        <span className="text-xs text-muted-foreground">
          {job.company} · {job.location || 'Location not stated'} · {ageText(job, now)}
          {job.fitScore !== undefined ? (
            <>
              {' · '}
              <span className="font-mono tabular-nums">
                fit {scoreText(job.fitScore)} · luck {scoreText(job.luckScore)}
              </span>
            </>
          ) : null}
        </span>
        {job.reason ? <span className="text-sm text-muted-foreground">{job.reason}</span> : null}
      </button>
      {hasAttribution ? (
        <div className="px-4 pb-1">
          <SourceAttribution job={job} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * A list of job rows with focus-scoped shortcuts (`j`/`k` `a` `s` `o`, ADR-038). Opening a row
 * is the caller's business; applied and skip run here and report back through `onChanged`.
 */
export function JobList({
  jobs,
  label,
  now,
  showVerdict = true,
  onOpen,
  onChanged,
  footer,
}: {
  jobs: readonly JobView[];
  label: string;
  now: Date;
  showVerdict?: boolean;
  onOpen: (jobId: string) => void;
  onChanged: () => void;
  footer?: ReactNode;
}) {
  const [error, setError] = useState<string>();
  const find = useCallback((id: string) => jobs.find((view) => view.id === id), [jobs]);

  const act = useCallback(
    (id: string, to: 'applied' | 'skipped') => {
      const view = find(id);
      if (!view || view.job.status === to) return;
      // Skipping an applied job would clear its applied stamps; the detail sheet hides Skip there.
      if (to === 'skipped' && view.job.status === 'applied') return;
      setError(undefined);
      setJobStatus(view, to).then(onChanged, (caught: unknown) => {
        setError(jobActionErrorMessage(caught));
      });
    },
    [find, onChanged],
  );
  const keys = useListKeys({
    onApplied: (id) => {
      act(id, 'applied');
    },
    onSkip: (id) => {
      act(id, 'skipped');
    },
    onOpenPosting: (id) => {
      const view = find(id);
      if (view) window.open(view.job.url, '_blank', 'noopener,noreferrer');
    },
  });

  return (
    <div>
      <ul
        aria-label={label}
        className="divide-y rounded-lg border bg-surface p-1 [&>li]:py-0.5"
        {...keys}
      >
        {jobs.map((view) => (
          <JobRow key={view.id} view={view} now={now} showVerdict={showVerdict} onOpen={onOpen} />
        ))}
      </ul>
      <div aria-live="polite">
        {error ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
      {footer}
    </div>
  );
}
