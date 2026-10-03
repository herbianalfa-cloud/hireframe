import type { RescoreResult } from '@hireframe/shared';
import { Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { rescore, rescoreErrorMessage } from '@/services/criteria';

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function resultText({ counts, funnel }: RescoreResult): string {
  const back = counts.queuedS2 + counts.queuedS3;
  const waiting = funnel.queued.s2 + funnel.queued.s3;
  return [
    `Re-scored ${plural(counts.jobs, 'job', 'jobs')}:`,
    `${String(counts.s1Changed)} changed by rules,`,
    `${String(counts.recomputed)} re-scored without AI,`,
    `${String(back)} sent back to the AI,`,
    `${String(counts.unchanged)} unchanged.`,
    waiting > 0 ? `${plural(waiting, 'job waits', 'jobs wait')} for the next run.` : '',
    `Cost ${(Math.round(funnel.costPence * 10) / 10).toString()}p.`,
  ]
    .filter((part) => part !== '')
    .join(' ');
}

/**
 * "Re-score last 14 days" (PRD R3, ADR-037): re-judges recent jobs under the current criteria.
 * Rule and threshold changes cost nothing; changed lanes, wildcards or company preferences send
 * jobs back to the AI within one run budget.
 */
export function RescoreCard() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string }>();

  async function run() {
    setOpen(false);
    setPending(true);
    setMessage(undefined);
    try {
      setMessage({ kind: 'ok', text: resultText(await rescore()) });
    } catch (error) {
      setMessage({ kind: 'error', text: rescoreErrorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="rescore-title" className="rounded-lg border bg-surface p-4 md:p-5">
      <h2 id="rescore-title" className="text-sm font-medium">
        Re-score recent jobs
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Judge the jobs from the last 14 days again with your current criteria. Rule and threshold
        changes cost nothing. Changed lanes, wildcards or company preferences send jobs back to the
        AI, within one run&apos;s budget.
      </p>
      <Button
        variant="secondary"
        className="mt-3"
        disabled={pending}
        onClick={() => {
          setMessage(undefined);
          setOpen(true);
        }}
      >
        {pending ? (
          <Loader2 aria-hidden="true" className="animate-spin" />
        ) : (
          <RefreshCw aria-hidden="true" />
        )}
        Re-score last 14 days
      </Button>
      <div aria-live="polite" className="mt-3 text-sm empty:mt-0">
        {pending ? (
          <p className="text-muted-foreground">Re-scoring… this can take a few minutes.</p>
        ) : null}
        {message ? (
          <p className={message.kind === 'error' ? 'text-danger' : 'text-foreground'}>
            {message.text}
          </p>
        ) : null}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Re-score the last 14 days?</DialogTitle>
          <DialogDescription>
            Jobs keep their current verdict until the new one is ready. It can use up to one
            run&apos;s AI budget, and it waits if a scan is running.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                void run();
              }}
            >
              Re-score
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
