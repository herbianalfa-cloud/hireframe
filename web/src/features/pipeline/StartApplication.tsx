import type { Application } from '@hireframe/shared';
import type { JobView } from '@/services/jobs';
import type { LiveState } from '@/services/profile';
import { ArrowRight, FilePlus2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { applicationErrorMessage, startApplication } from '@/services/applications';

import { BLOCKED_TEXT, STAGE_META } from './labels';

/**
 * Start application (M7): replaces the disabled Generate CV button. A separate control from
 * Apply (Mark applied). Once an application exists it shows its stage and links to Pipeline.
 */
export function StartApplication({
  view,
  state,
}: {
  view: JobView;
  /** The sheet's one application listener (`useApplication`), shared with Actions. */
  state: LiveState<Application | null>;
}) {
  const { job } = view;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [started, setStarted] = useState<string>();

  if (state.status === 'loading') {
    return <Skeleton role="status" aria-label="Loading application" className="h-11 w-48" />;
  }
  if (state.status === 'error') {
    return (
      <p role="alert" className="text-sm text-danger">
        {state.message}
      </p>
    );
  }

  const application = state.data;
  if (application && application.stage !== 'withdrawn') {
    const meta = STAGE_META[application.stage];
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1.5 text-sm">
          <meta.Icon aria-hidden="true" className={`size-4 shrink-0 ${meta.text}`} />
          <span className="text-muted-foreground">Application:</span>
          <span className="font-medium">{meta.label}</span>
        </span>
        <Button asChild variant="secondary">
          <Link to="/pipeline">
            Open in Pipeline
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
        {application.stage === 'chosen' && application.blocked ? (
          <p className="basis-full text-xs text-muted-foreground">
            {BLOCKED_TEXT[application.blocked.code]}
          </p>
        ) : null}
      </div>
    );
  }

  const reason = !job.verdict
    ? 'This job has not been judged yet.'
    : !job.deep
      ? 'It needs a full read of the posting first, and this job has none yet.'
      : job.status === 'applied'
        ? 'This job is already marked applied.'
        : undefined;

  async function start() {
    setPending(true);
    setError(undefined);
    setStarted(undefined);
    try {
      const result = await startApplication(view.id);
      setStarted(
        result.blocked
          ? `Started, but blocked: ${BLOCKED_TEXT[result.blocked]}`
          : result.stage === 'needs_input'
            ? 'Started. A few questions are waiting for you in Pipeline.'
            : 'Started. Your CV is being written.',
      );
    } catch (caught) {
      setError(applicationErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={pending || reason !== undefined}
          aria-describedby={reason ? 'start-application-reason' : undefined}
          onClick={() => {
            void start();
          }}
        >
          {pending ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <FilePlus2 aria-hidden="true" />
          )}
          Start application
        </Button>
        {reason ? (
          <span id="start-application-reason" className="text-xs text-muted-foreground">
            {reason}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            Writes a one-page CV and a cover note from your profile facts.
          </span>
        )}
      </div>
      <div aria-live="polite">
        {error ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        ) : started ? (
          <p className="mt-2 text-sm text-muted-foreground">{started}</p>
        ) : null}
      </div>
    </div>
  );
}
