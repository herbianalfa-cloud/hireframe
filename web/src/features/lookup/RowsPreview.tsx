import type { LookupRow } from '@hireframe/shared';
import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { pendingStateText } from '@/features/jobs/labels';
import { VerdictBadge } from '@/features/jobs/VerdictBadge';
import type { JobView } from '@/services/jobs';

export interface PreviewRow {
  row: LookupRow;
  /** The stored job when this row has been seen. */
  view: JobView | null;
}

/**
 * What Hireframe understood from a pasted results page, before anything is added. Seen rows are
 * shown for reference and can't be ticked; new rows are ticked and can be unticked.
 */
export function RowsPreview({
  rows,
  picked,
  adding,
  onPick,
  onOpen,
  onAdd,
}: {
  rows: readonly PreviewRow[];
  picked: ReadonlySet<number>;
  adding: boolean;
  onPick: (index: number, on: boolean) => void;
  onOpen: (jobId: string) => void;
  onAdd: () => void;
}) {
  const fresh = rows.filter((item) => item.view === null).length;
  return (
    <section aria-labelledby="preview-title" className="mt-6">
      <h2 id="preview-title" className="text-sm font-medium">
        Jobs on this page
        <span className="ml-2 font-mono text-xs text-muted-foreground tabular-nums">
          {rows.length} read · {fresh} new
        </span>
      </h2>
      <ul
        aria-label="Jobs read from the page"
        className="mt-2 divide-y rounded-lg border bg-surface"
      >
        {rows.map(({ row, view }, index) => {
          const pending = view ? pendingStateText(view.job) : null;
          return (
            <li key={`${row.linkedinId ?? row.company}:${row.title}:${String(index)}`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                {view ? (
                  <Badge variant="accent">Seen</Badge>
                ) : (
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={picked.has(index)}
                    aria-label={`Add ${row.title} at ${row.company}`}
                    onChange={(event) => {
                      onPick(index, event.target.checked);
                    }}
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="text-sm font-medium break-words">{row.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {row.company} · {row.location || 'Location not stated'}
                    {row.age ? ` · ${row.age}` : ''}
                  </span>
                </span>
                {view?.job.verdict ? <VerdictBadge verdict={view.job.verdict} /> : null}
                {pending ? <Badge>{pending}</Badge> : null}
                {view ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      onOpen(view.id);
                    }}
                  >
                    Open job
                    <span className="sr-only">: {row.title}</span>
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {fresh > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button disabled={adding || picked.size === 0} onClick={onAdd}>
            {adding ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            {adding ? 'Adding…' : `Add ${String(picked.size)} job${picked.size === 1 ? '' : 's'}`}
          </Button>
          <p className="text-xs text-muted-foreground">
            Each added job is judged at once, so this spends a little of today&apos;s Lookup limit.
          </p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Every job on this page has been seen.</p>
      )}
    </section>
  );
}
