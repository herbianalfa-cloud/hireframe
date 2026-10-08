import { Link } from 'react-router';

import { JobList } from '@/features/jobs/JobList';
import { ADDED_BY_YOU_SIZE } from '@/services/dashboard';

import { useAddedByYou } from './hooks';

/**
 * Jobs you added from Lookup (ADR-049): the newest few, with where each stands (verdict, needs a
 * description, queued, skipped). Hidden when there are none. It reads only after Today is usable
 * (`hf:usable`), so it never delays the tiles or the Apply list.
 */
export function AddedByYou({
  now,
  onOpen,
  onCommitted,
}: {
  now: Date;
  onOpen: (jobId: string) => void;
  onCommitted: () => void;
}) {
  const state = useAddedByYou();
  // Nothing is shown until there is something: no heading that appears and vanishes.
  if (state.status === 'loading' || (state.status === 'ready' && state.data.length === 0)) {
    return null;
  }
  return (
    <section aria-labelledby="list-added" className="mt-8">
      <h2 id="list-added" className="text-sm font-medium">
        Added by you
        {state.status === 'ready' ? (
          <span className="ml-2 font-mono text-xs text-muted-foreground tabular-nums">
            {state.data.length}
            {state.data.length === ADDED_BY_YOU_SIZE ? '+' : ''}
          </span>
        ) : null}
      </h2>
      <div className="mt-3">
        {state.status === 'error' ? (
          <p role="alert" className="text-sm text-danger">
            {state.message}
          </p>
        ) : (
          <JobList
            jobs={state.data}
            label="Added by you"
            now={now}
            onOpen={onOpen}
            onCommitted={onCommitted}
            footer={
              <p className="mt-2 text-xs text-muted-foreground">
                Showing the newest {ADDED_BY_YOU_SIZE}.{' '}
                <Link to="/jobs?added=1" className="underline underline-offset-4">
                  See all jobs you added →
                </Link>
              </p>
            }
          />
        )}
      </div>
    </section>
  );
}
