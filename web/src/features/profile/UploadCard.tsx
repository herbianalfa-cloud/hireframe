import {
  isParseStalled,
  planUploadRemoval,
  type ParseSummary,
  type UploadRemovalPlan,
} from '@hireframe/shared';
import {
  CircleAlert,
  CircleCheck,
  Clock,
  Copy,
  Loader2,
  Trash2,
  Upload,
  Undo2,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/format';
import {
  callableErrorMessage,
  cvKindOf,
  parseCv,
  removeUpload,
  uploadCv,
  writeErrorMessage,
  type DocumentView,
  type FactView,
  type LiveState,
} from '@/services/profile';

import { PARSE_ERROR_MESSAGES } from './labels';

type UploadState =
  | { phase: 'idle' }
  | { phase: 'uploading' }
  | { phase: 'reading' }
  | { phase: 'done'; summary: ParseSummary }
  | { phase: 'duplicate' }
  | { phase: 'note'; message: string }
  | { phase: 'error'; message: string };

function isDeadlineExceeded(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'functions/deadline-exceeded'
  );
}

export function summaryText(summary: ParseSummary): string {
  return `Added ${String(summary.added)}, unchanged ${String(summary.unchanged)}, flagged ${String(summary.flagged)} for review, ${String(summary.unverified)} without a matching quote`;
}

function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** What "Remove upload" will do (before) or did (after). */
export function removalText(plan: UploadRemovalPlan, done: boolean): string {
  const parts = [
    `${done ? 'Archived' : 'Archives'} ${count(plan.archive.length, 'fact', 'facts')}`,
    `${done ? 'dropped' : 'drops'} ${count(plan.dropReviews.length, 'proposed change', 'proposed changes')}`,
  ];
  const kept =
    plan.skippedEdited > 0
      ? ` ${done ? 'Kept' : 'Keeps'} ${count(plan.skippedEdited, 'fact', 'facts')} you edited.`
      : '';
  return `${parts.join(' and ')}.${kept}`;
}

type UploadStatus = DocumentView['document']['status'] | 'stalled' | 'removed';

function StatusChip({ status }: { status: UploadStatus }) {
  if (status === 'removed') {
    return (
      <Badge>
        <Undo2 aria-hidden="true" />
        Removed
      </Badge>
    );
  }
  if (status === 'parsing') {
    return (
      <Badge variant="accent">
        <Loader2 aria-hidden="true" className="animate-spin" />
        Reading
      </Badge>
    );
  }
  if (status === 'parsed') {
    return (
      <Badge variant="success">
        <CircleCheck aria-hidden="true" />
        Read
      </Badge>
    );
  }
  if (status === 'stalled') {
    return (
      <Badge variant="danger">
        <Clock aria-hidden="true" />
        Timed out
      </Badge>
    );
  }
  return (
    <Badge variant="danger">
      <CircleAlert aria-hidden="true" />
      Failed
    </Badge>
  );
}

/** The current time, refreshed every minute, so an abandoned parse shows as timed out. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

function RemoveUploadDialog({
  target,
  facts,
  onClose,
  onRemoved,
}: {
  target: DocumentView | null;
  facts: readonly FactView[];
  onClose: () => void;
  onRemoved: (message: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const plan = target ? planUploadRemoval(facts, target.id) : undefined;

  async function confirm() {
    if (!target) return;
    setPending(true);
    setError(undefined);
    try {
      const done = await removeUpload(target.id, facts);
      onRemoved(`Upload removed. ${removalText(done, true)}`);
      onClose();
    } catch (caught) {
      setError(writeErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Remove this upload?</DialogTitle>
        <DialogDescription>
          {target
            ? `The ${target.document.kind.toUpperCase()} from ${formatDate(target.document.createdAt)}. Archived facts can be restored from the Archived tab. The file itself is kept.`
            : null}
        </DialogDescription>
        {plan ? <p className="mt-4 text-sm">{removalText(plan, false)}</p> : null}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={pending}
            onClick={() => {
              void confirm();
            }}
          >
            {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            Remove upload
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RecentUploads({
  state,
  facts,
}: {
  state: LiveState<DocumentView[]>;
  facts: LiveState<FactView[]>;
}) {
  const now = useNow();
  const [removing, setRemoving] = useState<DocumentView | null>(null);
  const [removed, setRemoved] = useState<string>();
  if (state.status === 'loading') {
    return (
      <div role="status" aria-label="Loading uploads" className="mt-4 space-y-2">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
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
    return <p className="mt-4 text-sm text-muted-foreground">No uploads yet.</p>;
  }
  const documents = state.data;
  const loadedFacts = facts.status === 'ready' ? facts.data : null;
  const createdAt = (docId: string) =>
    documents.find((item) => item.id === docId)?.document.createdAt;
  return (
    <div className="mt-4">
      <h3 className="text-sm font-medium">Recent uploads</h3>
      <ul className="mt-2 divide-y rounded-md border">
        {documents.map((view) => {
          const { id, document } = view;
          const status: UploadStatus = document.removedAt
            ? 'removed'
            : isParseStalled(document, now)
              ? 'stalled'
              : document.status;
          const original = document.duplicateOf ? createdAt(document.duplicateOf) : undefined;
          return (
            <li
              key={id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm"
            >
              <span className="font-mono text-xs uppercase">{document.kind}</span>
              <span className="text-muted-foreground">{formatDate(document.createdAt)}</span>
              <StatusChip status={status} />
              {(status === 'parsed' || status === 'failed') && !document.duplicateOf ? (
                <Button
                  variant="ghost"
                  className="ml-auto"
                  disabled={!loadedFacts}
                  aria-label={`Remove upload from ${formatDate(document.createdAt)}`}
                  onClick={() => {
                    setRemoved(undefined);
                    setRemoving(view);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  Remove upload
                </Button>
              ) : null}
              {document.duplicateOf ? (
                <p className="flex basis-full items-center gap-1.5 text-xs text-muted-foreground">
                  <Copy aria-hidden="true" className="size-3.5 shrink-0" />
                  {original
                    ? `Same file as the upload from ${formatDate(original)}. Nothing changed.`
                    : 'Same file as an earlier upload. Nothing changed.'}
                </p>
              ) : null}
              {isParseStalled(document, now) ? (
                <p className="basis-full text-xs text-muted-foreground">
                  Reading this CV took too long and stopped. Upload it again to retry.
                </p>
              ) : null}
              {document.status === 'failed' ? (
                <p className="basis-full text-xs text-muted-foreground">
                  {PARSE_ERROR_MESSAGES[document.errorCode ?? 'internal']}
                </p>
              ) : null}
              {document.status === 'parsed' && document.summary ? (
                <p className="basis-full text-xs text-muted-foreground">
                  {summaryText(document.summary)}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p aria-live="polite" className="mt-2 text-sm empty:mt-0">
        {removed}
      </p>
      <RemoveUploadDialog
        target={removing}
        facts={loadedFacts ?? []}
        onClose={() => {
          setRemoving(null);
        }}
        onRemoved={setRemoved}
      />
    </div>
  );
}

/** Upload a CV, wait for it to be read, and list recent uploads with their status. */
export function UploadCard({
  documents,
  facts,
}: {
  documents: LiveState<DocumentView[]>;
  facts: LiveState<FactView[]>;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ phase: 'idle' });
  const busy = state.phase === 'uploading' || state.phase === 'reading';

  async function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      cvKindOf(file);
    } catch (error) {
      setState({
        phase: 'error',
        message: error instanceof Error ? error.message : 'Choose a PDF or Word (.docx) file.',
      });
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    setState({ phase: 'uploading' });
    let docId: string;
    try {
      docId = await uploadCv(file);
    } catch {
      setState({
        phase: 'error',
        message: "Couldn't upload the file. Check your connection and try again.",
      });
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    setState({ phase: 'reading' });
    try {
      const result = await parseCv(docId);
      setState(
        result.duplicateOf ? { phase: 'duplicate' } : { phase: 'done', summary: result.summary },
      );
    } catch (error) {
      const message = callableErrorMessage(error);
      // A client timeout is not a failure: the upload's status below is the truth.
      setState(
        isDeadlineExceeded(error) ? { phase: 'note', message } : { phase: 'error', message },
      );
    }
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <section aria-labelledby="upload-title" className="rounded-lg border bg-surface p-4 md:p-5">
      <h2 id="upload-title" className="text-sm font-medium">
        Upload your CV
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        PDF or Word (.docx), up to 5 MB. Re-uploading adds new facts and flags changed ones for your
        review. Remove an upload to archive the facts it added.
      </p>
      <div className="mt-3">
        <label htmlFor={inputId} className="sr-only">
          CV file (PDF or Word)
        </label>
        <div className="flex items-center gap-2">
          <Upload aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept=".pdf,.docx"
            disabled={busy}
            onChange={(event) => {
              void onChange(event);
            }}
            className="min-h-11 w-full min-w-0 text-sm text-muted-foreground file:mr-3 file:h-11 file:cursor-pointer file:rounded-md file:border file:bg-surface-raised file:px-4 file:text-sm file:font-medium file:text-foreground disabled:opacity-50"
          />
        </div>
      </div>
      <div aria-live="polite" className="mt-3 text-sm empty:mt-0">
        {state.phase === 'uploading' ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            Uploading…
          </p>
        ) : null}
        {state.phase === 'reading' ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            Reading your CV… This can take a minute or more.
          </p>
        ) : null}
        {state.phase === 'done' ? (
          <p className="flex items-start gap-2">
            <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-verdict-apply" />
            {summaryText(state.summary)}
          </p>
        ) : null}
        {state.phase === 'duplicate' ? (
          <p className="flex items-start gap-2">
            <Copy aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            This is the same file as an earlier upload, so it wasn&apos;t read again. Nothing
            changed.
          </p>
        ) : null}
        {state.phase === 'note' ? <p className="text-muted-foreground">{state.message}</p> : null}
        {state.phase === 'error' ? (
          <p className="flex items-start gap-2 text-danger">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {state.message}
          </p>
        ) : null}
      </div>
      <RecentUploads state={documents} facts={facts} />
    </section>
  );
}
