import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/format';
import type { FactView } from '@/services/profile';

import { CHANGE_LABELS } from './labels';
import { useFactVersions } from './hooks';

function Versions({ factId }: { factId: string }) {
  const state = useFactVersions(factId);
  if (state.status === 'loading') {
    return (
      <div role="status" aria-label="Loading history" className="mt-4 space-y-3">
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <p role="alert" className="mt-4 text-sm text-danger">
        {state.message}
      </p>
    );
  }
  if (state.data.length === 0) {
    return <p className="mt-4 text-sm text-muted-foreground">No history yet.</p>;
  }
  return (
    <ol className="mt-4 space-y-3">
      {state.data.map(({ version, entry }) => (
        <li key={version} className="rounded-md border bg-surface-raised p-3">
          <p className="font-mono text-xs text-muted-foreground">
            v{version} · {CHANGE_LABELS[entry.change]} · {formatDate(entry.at)}
          </p>
          <p className="mt-1 text-sm">{entry.snapshot.text}</p>
        </li>
      ))}
    </ol>
  );
}

/** Right-hand sheet with a fact's versions, newest first. */
export function HistorySheet({ view, onClose }: { view: FactView | null; onClose: () => void }) {
  return (
    <Dialog
      open={view !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent side="right">
        <DialogTitle>Fact history</DialogTitle>
        <DialogDescription>Every saved version of this fact, newest first.</DialogDescription>
        {view ? <Versions factId={view.id} /> : null}
      </DialogContent>
    </Dialog>
  );
}
