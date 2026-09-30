import { Check, GitCompareArrows, Loader2, Undo2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { acceptReview, keepReview, writeErrorMessage, type FactView } from '@/services/profile';

import { formatFactDates } from './labels';

function ReviewItem({ view }: { view: FactView }) {
  const [pending, setPending] = useState<'accept' | 'keep'>();
  const [error, setError] = useState<string>();
  const { fact } = view;
  const review = fact.review;
  if (!review) return null;

  const currentDates = formatFactDates(fact.dates);
  const proposedDates = formatFactDates(review.proposed.dates);

  async function run(kind: 'accept' | 'keep') {
    setPending(kind);
    setError(undefined);
    try {
      await (kind === 'accept' ? acceptReview(view) : keepReview(view));
    } catch (caught) {
      setError(writeErrorMessage(caught));
    } finally {
      setPending(undefined);
    }
  }

  return (
    <li className="rounded-md border bg-surface-raised p-3 md:p-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase">Current</p>
          <p className="mt-1 text-sm">{fact.text}</p>
          {currentDates !== proposedDates ? (
            <p className="mt-1 text-xs text-muted-foreground">{currentDates ?? 'No dates'}</p>
          ) : null}
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase">Proposed</p>
          <p className="mt-1 text-sm">{review.proposed.text}</p>
          {currentDates !== proposedDates ? (
            <p className="mt-1 text-xs text-muted-foreground">{proposedDates ?? 'No dates'}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          disabled={pending !== undefined}
          onClick={() => {
            void run('accept');
          }}
        >
          {pending === 'accept' ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <Check aria-hidden="true" />
          )}
          Accept change
        </Button>
        <Button
          variant="secondary"
          disabled={pending !== undefined}
          onClick={() => {
            void run('keep');
          }}
        >
          {pending === 'keep' ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <Undo2 aria-hidden="true" />
          )}
          Keep current
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** Changes proposed by a CV re-upload. Nothing changes until the owner accepts. */
export function ReviewSection({ facts }: { facts: FactView[] }) {
  const flagged = facts.filter((view) => view.fact.review);
  if (flagged.length === 0) return null;
  return (
    <section
      aria-labelledby="review-title"
      className="rounded-lg border border-accent/40 bg-surface p-4 md:p-5"
    >
      <h2 id="review-title" className="flex items-center gap-2 text-sm font-medium">
        <GitCompareArrows aria-hidden="true" className="size-4 text-accent" />
        Needs review ({flagged.length})
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Your latest CV words these facts differently. Accept the new wording or keep what you have.
      </p>
      <ul className="mt-3 space-y-3">
        {flagged.map((view) => (
          <ReviewItem key={view.id} view={view} />
        ))}
      </ul>
    </section>
  );
}
