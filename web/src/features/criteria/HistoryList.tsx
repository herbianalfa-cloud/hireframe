import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/format';

import { useCriteriaHistory } from './hooks';

/** Saved criteria versions, newest first. Viewing or restoring old versions is not built yet. */
export function HistoryList({ currentVersion }: { currentVersion: number }) {
  const state = useCriteriaHistory();
  return (
    <section aria-labelledby="history-title" className="rounded-lg border bg-surface p-4 md:p-5">
      <h2 id="history-title" className="text-sm font-medium">
        History
      </h2>
      {state.status === 'loading' ? (
        <div role="status" aria-label="Loading history" className="mt-3 space-y-2">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      ) : null}
      {state.status === 'error' ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {state.message}
        </p>
      ) : null}
      {state.status === 'ready' && state.versions.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No saved versions yet.</p>
      ) : null}
      {state.status === 'ready' && state.versions.length > 0 ? (
        <ol className="mt-3 divide-y">
          {state.versions.map(({ version, createdAt }) => (
            <li key={version} className="flex min-h-11 items-center gap-3 text-sm">
              <span className="font-mono text-xs">
                v{version} · {formatDate(createdAt)}
              </span>
              {version === currentVersion ? <Badge variant="accent">Current</Badge> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
