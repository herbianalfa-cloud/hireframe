import { JOB_LIMITS, LOOKUP_LIMITS, type LookupTarget } from '@hireframe/shared';
import { Loader2 } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { lookupAdd, lookupDescribe, lookupErrorMessage } from '@/services/lookup';

import { busyText, capText, describeText, outcomeText } from './model';

/**
 * Add one job by hand (ADR-049): for a link Hireframe won't fetch (LinkedIn, careers pages,
 * Indeed, Wellfound...). The owner gives the title and company, and the description if they have
 * it. The job is added and, when a description is here, judged straight away.
 */
export function ManualAdd({
  target,
  onAdded,
}: {
  target: LookupTarget;
  onAdded: (jobId?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string }>();
  const tooLong = description.length > LOOKUP_LIMITS.description;

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (pending || !title.trim() || !company.trim() || tooLong) return;
    setPending(true);
    setMessage(undefined);
    try {
      const added = await lookupAdd([
        {
          kind: 'row',
          title,
          company,
          location,
          ...(target.linkedinId ? { linkedinId: target.linkedinId } : {}),
        },
      ]);
      if (added.status === 'busy') {
        setMessage({ kind: 'error', text: busyText(added.retryAfterSeconds) });
        return;
      }
      const outcome = added.outcomes[0];
      if (!outcome) {
        setMessage({ kind: 'error', text: "Couldn't be added." });
        return;
      }
      const jobId = 'jobId' in outcome ? outcome.jobId : undefined;
      if (outcome.status === 'needs_description' && jobId && description.trim()) {
        const judged = await lookupDescribe(jobId, description);
        setMessage({ kind: 'ok', text: `Added. ${describeText(judged)}` });
      } else {
        setMessage({
          kind: 'ok',
          text: [outcomeText(outcome), capText(added.capReached)].filter(Boolean).join(' '),
        });
      }
      onAdded(jobId);
    } catch (error) {
      setMessage({ kind: 'error', text: lookupErrorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <div>
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(true);
          }}
        >
          Add by hand
          <span className="sr-only"> this link</span>
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">
          Hireframe won&apos;t fetch this page. Give the title, company and description yourself.
        </p>
      </div>
    );
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 rounded-md border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title">
          {(control) => (
            <Input
              {...control}
              value={title}
              maxLength={JOB_LIMITS.title}
              required
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Company">
          {(control) => (
            <Input
              {...control}
              value={company}
              maxLength={JOB_LIMITS.company}
              required
              onChange={(event) => {
                setCompany(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
      <Field label="Location (optional)">
        {(control) => (
          <Input
            {...control}
            value={location}
            maxLength={JOB_LIMITS.location}
            onChange={(event) => {
              setLocation(event.target.value);
            }}
          />
        )}
      </Field>
      <Field
        label="Description (optional)"
        hint="Paste it now to have the job judged, or add it later under Waiting for a description."
        error={tooLong ? 'Too long.' : undefined}
      >
        {(control) => (
          <Textarea
            {...control}
            rows={6}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending || !title.trim() || !company.trim() || tooLong}>
          {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          {pending ? 'Adding…' : description.trim() ? 'Add and judge' : 'Add job'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
          }}
        >
          Cancel
        </Button>
      </div>
      <div aria-live="polite">
        {message ? (
          <p
            role={message.kind === 'error' ? 'alert' : 'status'}
            className={`text-sm ${message.kind === 'error' ? 'text-danger' : ''}`}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}
