import { RESET_CONFIRMATION } from '@hireframe/shared';
import { Loader2, TriangleAlert } from 'lucide-react';
import { useId, useState, type SubmitEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { callableErrorMessage, resetProfile } from '@/services/profile';

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function ResetForm({ onDone }: { onDone: (message: string) => void }) {
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const confirmed = typed === RESET_CONFIRMATION;

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!confirmed) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await resetProfile(typed);
      onDone(
        `Profile reset. Deleted ${plural(result.facts, 'fact', 'facts')}, ${plural(result.documents, 'upload', 'uploads')} and ${plural(result.files, 'file', 'files')}.`,
      );
    } catch (caught) {
      setError(callableErrorMessage(caught));
      setPending(false);
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="mt-4 space-y-3"
    >
      <label htmlFor={inputId} className="block text-sm font-medium">
        Type {RESET_CONFIRMATION} to confirm
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
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" variant="danger" disabled={!confirmed || pending}>
          {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          Delete everything
        </Button>
      </div>
    </form>
  );
}

/** Reset profile (ADR-023): hard-delete every fact, version, upload and file. */
export function DangerZone() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string>();

  return (
    <section
      aria-labelledby="danger-title"
      className="rounded-lg border border-danger/40 bg-surface p-4 md:p-5"
    >
      <h2 id="danger-title" className="flex items-center gap-2 text-sm font-medium text-danger">
        <TriangleAlert aria-hidden="true" className="size-4" />
        Danger zone
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Reset profile permanently deletes every fact, its history, every upload and the uploaded
        files. Criteria and spend are kept. This can&apos;t be undone.
      </p>
      <Button
        variant="danger"
        className="mt-3"
        onClick={() => {
          setMessage(undefined);
          setOpen(true);
        }}
      >
        Reset profile
      </Button>
      <p aria-live="polite" className="mt-3 text-sm empty:mt-0">
        {message}
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Reset your profile?</DialogTitle>
          <DialogDescription>
            Every fact, version, upload and uploaded file is deleted for good. You can upload your
            CV again afterwards.
          </DialogDescription>
          {open ? (
            <ResetForm
              onDone={(done) => {
                setMessage(done);
                setOpen(false);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
