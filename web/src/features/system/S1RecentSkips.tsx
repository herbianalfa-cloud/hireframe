import { ADOPTED_S1_RULE_IDS } from '@hireframe/shared';
import { useState } from 'react';
import { Link } from 'react-router';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  diagnosticsErrorMessage,
  loadRecentS1Skips,
  S1_SKIPS_DAYS,
  S1_SKIPS_PER_RULE,
  type RecentS1Skip,
} from '@/services/funnel-diagnostics';

/**
 * "Recent S1 skips by rule" (ADR-045): the spot-check for the S1 rules added from S2's skip
 * reasons. A false skip at S1 is silent and free, so for the first week the owner reads each
 * adopted rule's list; a job that shouldn't be there means deleting or narrowing that term in
 * Criteria and pressing Re-score. Titles and companies show on screen only, and are never part
 * of the S2 panel's "Copy counts".
 */

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; skips: Record<string, RecentS1Skip[]> }
  | { status: 'error'; message: string };

export function S1RecentSkips() {
  const [state, setState] = useState<State>({ status: 'idle' });
  async function load() {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', skips: await loadRecentS1Skips(new Date()) });
    } catch (error) {
      setState({ status: 'error', message: diagnosticsErrorMessage(error) });
    }
  }
  return (
    <section aria-labelledby="s1-skips-title" className="mt-8">
      <h2 id="s1-skips-title" className="text-sm font-medium">
        Recent S1 skips by rule
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Up to {S1_SKIPS_PER_RULE} jobs per sales-title rule from the last {S1_SKIPS_DAYS} days. If
        one shouldn't have been skipped, delete or narrow that term in Criteria and press Re-score.
      </p>
      <div className="mt-3">
        <Button
          type="button"
          variant="secondary"
          disabled={state.status === 'loading'}
          onClick={() => void load()}
        >
          {state.status === 'ready' ? 'Reload recent skips' : 'Load recent skips'}
        </Button>
      </div>
      {state.status === 'loading' ? <Skeleton className="mt-4 h-24 w-full" /> : null}
      {state.status === 'error' ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {state.message}
        </p>
      ) : null}
      {state.status === 'ready' ? (
        <div className="mt-4 space-y-4">
          {ADOPTED_S1_RULE_IDS.map((ruleId) => {
            const jobs = state.skips[ruleId] ?? [];
            return (
              <div key={ruleId}>
                <h3 className="font-mono text-xs text-muted-foreground">
                  {ruleId} ({jobs.length})
                </h3>
                {jobs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None.</p>
                ) : (
                  <ul className="mt-1 divide-y rounded-lg border bg-surface text-sm">
                    {jobs.map((job) => (
                      <li key={job.id}>
                        <Link
                          to={`/jobs?job=${encodeURIComponent(job.id)}`}
                          className="block px-3 py-2 underline-offset-4 hover:underline"
                        >
                          {job.title} <span className="text-muted-foreground">· {job.company}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
