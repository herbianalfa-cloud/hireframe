import { JOB_LIMITS, VERDICTS, type Verdict } from '@hireframe/shared';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { jobActionErrorMessage, rateJob, type JobView } from '@/services/jobs';

import { VERDICT_LABELS } from './labels';

/** 👎 on a verdict: an optional note and what it should have been (ADR-038). */
export function FeedbackDialog({
  view,
  onClose,
  onSaved,
}: {
  view: JobView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const verdict = view.job.verdict;
  const [note, setNote] = useState('');
  const [expected, setExpected] = useState<Verdict | ''>('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function submit() {
    setPending(true);
    setError(undefined);
    try {
      await rateJob(view, {
        agree: false,
        note,
        expected: expected === '' ? undefined : expected,
      });
      onSaved();
      onClose();
    } catch (caught) {
      setError(jobActionErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>What was wrong with this verdict?</DialogTitle>
        <DialogDescription>
          {verdict ? `It was judged ${VERDICT_LABELS[verdict]}.` : null} Your note is stored on the
          job and helps measure how often the verdicts are right.
        </DialogDescription>
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field label="It should have been (optional)">
            {(control) => (
              <select
                {...control}
                value={expected}
                onChange={(event) => {
                  setExpected(event.target.value as Verdict | '');
                }}
                className="h-11 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">Not sure</option>
                {VERDICTS.filter((item) => item !== verdict).map((item) => (
                  <option key={item} value={item}>
                    {VERDICT_LABELS[item]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label="Note (optional)"
            hint={`${String(note.length)}/${String(JOB_LIMITS.feedbackNote)}`}
          >
            {(control) => (
              <Textarea
                {...control}
                value={note}
                maxLength={JOB_LIMITS.feedbackNote}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            )}
          </Field>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save rating'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
