import { CircleAlert, Loader2, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { criteriaErrorMessage, seedCriteria } from '@/services/criteria';

import { CriteriaForm } from './CriteriaForm';
import { useCurrentCriteria } from './hooks';

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="page-title" className="mx-auto max-w-5xl">
      <h1 id="page-title" className="text-xl font-semibold tracking-tight">
        Criteria
      </h1>
      {children}
    </section>
  );
}

function EmptyCriteria() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function seed() {
    setPending(true);
    setError(undefined);
    try {
      await seedCriteria();
    } catch (caught) {
      setError(criteriaErrorMessage(caught));
      setPending(false);
    }
  }

  return (
    <PageFrame>
      <div className="mt-6 flex flex-col items-center rounded-lg border border-dashed bg-surface px-6 py-16 text-center">
        <SlidersHorizontal aria-hidden="true" className="size-6 text-muted-foreground" />
        <h2 className="mt-3 text-sm font-medium">No criteria yet</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Start from the default lanes, exclusions and thresholds, then adjust them to fit.
        </p>
        <Button
          className="mt-4"
          disabled={pending}
          onClick={() => {
            void seed();
          }}
        >
          {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          Start from default criteria
        </Button>
        <div aria-live="polite" className="mt-3 text-sm">
          {error ? <p className="text-danger">{error}</p> : null}
        </div>
      </div>
    </PageFrame>
  );
}

/** Criteria: the one editable, versioned document the funnel judges jobs against (PRD R3). */
export function CriteriaPage() {
  const state = useCurrentCriteria();

  if (state.status === 'loading') {
    return (
      <PageFrame>
        <div role="status" aria-label="Loading criteria" className="mt-6 space-y-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </PageFrame>
    );
  }
  if (state.status === 'error') {
    return (
      <PageFrame>
        <div
          role="alert"
          className="mt-6 flex items-start gap-2 rounded-lg border border-danger/40 bg-surface p-4 text-sm text-danger"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {state.message}
        </div>
      </PageFrame>
    );
  }
  if (state.status === 'empty') return <EmptyCriteria />;
  return <CriteriaForm criteria={state.criteria} />;
}
