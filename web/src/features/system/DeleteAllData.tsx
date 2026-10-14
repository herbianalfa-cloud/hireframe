import { WIPE_CONFIRMATION, WIPE_STEP_LABELS } from '@hireframe/shared';
import { Loader2, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState, type SubmitEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { callableErrorMessage } from '@/services/profile';
import {
  EMPTY_WIPE_TOTALS,
  PREVIEW_COUNTS,
  PROFILE_PREVIEW_COUNTS,
  WIPE_MAX_CALLS,
  deleteAllData,
  previewCount,
  runWipe,
  type WipeTotals,
} from '@/services/wipe';

type Count = { status: 'loading' } | { status: 'ready'; count: number } | { status: 'failed' };

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function usePreview(paths: readonly { key: string; path: string }[]): Record<string, Count> {
  const [counts, setCounts] = useState<Record<string, Count>>(() =>
    Object.fromEntries(paths.map(({ key }) => [key, { status: 'loading' }])),
  );
  useEffect(() => {
    let cancelled = false;
    for (const { key, path } of paths) {
      previewCount(path).then(
        (count) => {
          if (!cancelled)
            setCounts((previous) => ({ ...previous, [key]: { status: 'ready', count } }));
        },
        () => {
          if (!cancelled) setCounts((previous) => ({ ...previous, [key]: { status: 'failed' } }));
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [paths]);
  return counts;
}

const ALL_COUNTS = [...PREVIEW_COUNTS, ...PROFILE_PREVIEW_COUNTS];

function CountLine({ label, state }: { label: string; state: Count | undefined }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span>{label}</span>
      {state?.status === 'ready' ? (
        <span className="tabular-nums">{state.count}</span>
      ) : state?.status === 'failed' ? (
        <span className="text-muted-foreground">unavailable</span>
      ) : (
        <Skeleton role="status" aria-label={`Counting ${label}`} className="h-4 w-10" />
      )}
    </li>
  );
}

function progressLine(totals: WipeTotals): string {
  const so_far = `Deleted ${plural(totals.documents, 'document', 'documents')} and ${plural(totals.files, 'file', 'files')} so far`;
  if (totals.remaining.length === 0) return so_far;
  const todo = totals.remaining.map((step) => WIPE_STEP_LABELS[step]).join(', ');
  return `${so_far} · still to do: ${todo}`;
}

function Form({ onFinished }: { onFinished: () => void }) {
  const inputId = useId();
  const profileId = useId();
  const counts = usePreview(ALL_COUNTS);
  const [typed, setTyped] = useState('');
  const [resetProfile, setResetProfile] = useState(false);
  const [running, setRunning] = useState(false);
  const [totals, setTotals] = useState<WipeTotals>(EMPTY_WIPE_TOTALS);
  const [error, setError] = useState<string>();
  // What was ticked when the wipe started: Continue and the summary use it, not the live box.
  const [sentProfile, setSentProfile] = useState(false);
  const confirmed = typed === WIPE_CONFIRMATION;
  const started = totals.calls > 0 || running || error !== undefined;
  const stoppedAtCap = !running && !totals.done && error === undefined && totals.calls > 0;

  async function go(from: WipeTotals, withProfile: boolean) {
    setRunning(true);
    setError(undefined);
    try {
      const result = await runWipe(
        { confirm: WIPE_CONFIRMATION, resetProfile: withProfile },
        { from, onProgress: setTotals, call: deleteAllData },
      );
      setTotals(result);
    } catch (caught) {
      setError(callableErrorMessage(caught));
    } finally {
      setRunning(false);
    }
  }

  function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!confirmed || running) return;
    setSentProfile(resetProfile);
    void go(EMPTY_WIPE_TOTALS, resetProfile);
  }

  if (totals.done) {
    return (
      <div className="mt-4 space-y-3">
        <p role="status" className="text-sm">
          Done. Deleted {plural(totals.documents, 'document', 'documents')} and{' '}
          {plural(totals.files, 'file', 'files')}.
          {sentProfile
            ? ` Profile reset: ${plural(totals.profile.facts, 'fact', 'facts')}, ${plural(totals.profile.documents, 'upload', 'uploads')} and ${plural(totals.profile.files, 'file', 'files')} deleted.`
            : ''}
        </p>
        <div className="flex justify-end">
          <Button type="button" onClick={onFinished}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  if (started) {
    return (
      <div className="mt-4 space-y-3">
        <p role="status" aria-live="polite" className="text-sm">
          {running ? (
            <Loader2 aria-hidden="true" className="mr-2 inline size-4 animate-spin" />
          ) : null}
          {progressLine(totals)}
        </p>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        {stoppedAtCap ? (
          <p className="text-sm text-muted-foreground">
            That was {String(WIPE_MAX_CALLS)} passes and there is more to delete.
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          {error || stoppedAtCap ? (
            <Button type="button" variant="secondary" onClick={onFinished}>
              Close
            </Button>
          ) : null}
          {stoppedAtCap ? (
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                void go(totals, sentProfile);
              }}
            >
              Continue
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <form noValidate onSubmit={onSubmit} className="mt-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium">What will be deleted</h3>
        <ul className="mt-2 space-y-1 text-sm">
          {PREVIEW_COUNTS.map(({ key, label }) => (
            <CountLine key={key} label={label} state={counts[key]} />
          ))}
          <li className="text-muted-foreground">Saved email alert records (not counted)</li>
        </ul>
      </div>
      <p className="text-sm text-muted-foreground">
        Kept: your criteria, settings, AI spend history, the source call limits and pauses, and your
        profile unless you tick the box below.
      </p>
      <div>
        <label htmlFor={profileId} className="flex min-h-11 items-start gap-2 text-sm">
          <input
            id={profileId}
            type="checkbox"
            checked={resetProfile}
            onChange={(event) => {
              setResetProfile(event.target.checked);
            }}
            className="mt-1 size-4"
          />
          <span>Also reset profile (every fact, upload and uploaded file)</span>
        </label>
        {resetProfile ? (
          <ul className="mt-1 space-y-1 pl-6 text-sm">
            {PROFILE_PREVIEW_COUNTS.map(({ key, label }) => (
              <CountLine key={key} label={label} state={counts[key]} />
            ))}
          </ul>
        ) : null}
      </div>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>
          The next scan re-creates the watchlist from the seed, so edits you made in the console are
          lost.
        </li>
        <li>
          Backups keep data for up to 8 weeks, and deleted files stay restorable for 7 days. The
          runbook&apos;s full-erase step removes the backups.
        </li>
        <li>This can&apos;t be undone.</li>
      </ul>
      <div className="space-y-2">
        <label htmlFor={inputId} className="block text-sm font-medium">
          Type {WIPE_CONFIRMATION} to confirm
        </label>
        <Input
          id={inputId}
          value={typed}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="danger" disabled={!confirmed}>
          Delete all my data
        </Button>
      </div>
    </form>
  );
}

/** Delete all my data (ADR-057), in the System page's Danger zone. */
export function DeleteAllData() {
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-labelledby="wipe-title"
      className="mt-8 rounded-lg border border-danger/40 bg-surface p-4 md:p-5"
    >
      <h2 id="wipe-title" className="flex items-center gap-2 text-sm font-medium text-danger">
        <TriangleAlert aria-hidden="true" className="size-4" />
        Danger zone
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Delete all my data permanently removes every job, application, generated CV and run. Your
        criteria and spend history are kept, and so is your profile unless you tick the box.
      </p>
      <Button
        variant="danger"
        className="mt-3"
        onClick={() => {
          setOpen(true);
        }}
      >
        Delete all my data
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Delete all your data?</DialogTitle>
          <DialogDescription>
            This removes your jobs, applications and generated CVs for good.
          </DialogDescription>
          {open ? (
            <Form
              onFinished={() => {
                setOpen(false);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
