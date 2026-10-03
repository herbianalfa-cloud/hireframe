import { ISO_DATE_PATTERN, WORK_RIGHTS, type WorkRights } from '@hireframe/shared';
import { Loader2 } from 'lucide-react';
import { useId, useState, type SubmitEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { saveWorkRights, type WorkRightsView } from '@/services/profile';

import { useWorkRights } from './hooks';

const OPTIONS: Readonly<Record<WorkRights, { label: string; hint: string }>> = {
  unrestricted: {
    label: 'No restrictions',
    hint: 'Citizen, settled status or indefinite leave to remain.',
  },
  time_limited: {
    label: 'Time-limited permission',
    hint: 'A visa that lets you work now without sponsorship, until a date.',
  },
  needs_sponsorship: {
    label: 'Needs sponsorship',
    hint: 'An employer must sponsor a visa for you to work in the UK.',
  },
};

/**
 * Work rights (ADR-033): S1 skips postings whose wording excludes them (for example "must have
 * indefinite leave to remain"), and S2/S3 see them in the candidate summary. Stored only in
 * Firebase, never in the repo.
 */
type Message = { kind: 'ok' | 'error'; text: string } | undefined;

export function WorkRightsCard() {
  const state = useWorkRights();
  // Kept here: a save changes the stored value, which starts the form again.
  const [message, setMessage] = useState<Message>();
  if (state.status === 'loading') {
    return (
      <div role="status" aria-label="Loading work rights">
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <p role="alert" className="text-sm text-danger">
        {state.message}
      </p>
    );
  }
  // A new stored value (saved here or elsewhere) starts the form again from it.
  return (
    <WorkRightsForm
      key={JSON.stringify(state.data)}
      stored={state.data}
      message={message}
      setMessage={setMessage}
    />
  );
}

function WorkRightsForm({
  stored,
  message,
  setMessage,
}: {
  stored: WorkRightsView;
  message: Message;
  setMessage: (message: Message) => void;
}) {
  const groupId = useId();
  const dateId = useId();
  const [choice, setChoice] = useState<WorkRights | null>(stored?.workRights ?? null);
  const [validUntil, setValidUntil] = useState(stored?.validUntil ?? '');
  const [pending, setPending] = useState(false);

  const dateInvalid = validUntil !== '' && !ISO_DATE_PATTERN.test(validUntil);
  const changed =
    choice !== (stored?.workRights ?? null) || validUntil !== (stored?.validUntil ?? '');

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!choice || dateInvalid) return;
    setPending(true);
    setMessage(undefined);
    try {
      await saveWorkRights(
        {
          workRights: choice,
          ...(choice === 'time_limited' && validUntil ? { validUntil } : {}),
        },
        stored !== null,
      );
      setMessage({ kind: 'ok', text: 'Saved. The next scan uses it.' });
    } catch {
      setMessage({ kind: 'error', text: "Couldn't save. Check your connection and try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="work-rights-title"
      className="rounded-lg border bg-surface p-4 md:p-5"
    >
      <h2 id="work-rights-title" className="text-sm font-medium">
        Work rights
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Used to skip postings you can&apos;t apply to, like ones that require indefinite leave to
        remain. {stored ? null : 'Until you set this, those postings are flagged, not skipped.'}
      </p>
      <form
        noValidate
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          void onSubmit(event);
        }}
      >
        <fieldset>
          <legend id={groupId} className="sr-only">
            Your right to work in the UK
          </legend>
          <div className="space-y-2">
            {WORK_RIGHTS.map((value) => (
              <label
                key={value}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-accent"
              >
                <input
                  type="radio"
                  name="work-rights"
                  value={value}
                  className="mt-1"
                  checked={choice === value}
                  onChange={() => {
                    setChoice(value);
                    setMessage(undefined);
                  }}
                />
                <span>
                  <span className="block text-sm font-medium">{OPTIONS[value].label}</span>
                  <span className="block text-xs text-muted-foreground">{OPTIONS[value].hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {choice === 'time_limited' ? (
          <div>
            <label htmlFor={dateId} className="block text-sm font-medium">
              Valid until (optional)
            </label>
            <Input
              id={dateId}
              type="date"
              className="mt-1 max-w-48"
              value={validUntil}
              aria-invalid={dateInvalid}
              onChange={(event) => {
                setValidUntil(event.target.value);
                setMessage(undefined);
              }}
            />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!choice || !changed || dateInvalid || pending}>
            {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            Save work rights
          </Button>
          <p aria-live="polite" className="text-sm">
            {message ? (
              <span className={message.kind === 'error' ? 'text-danger' : 'text-foreground'}>
                {message.text}
              </span>
            ) : null}
          </p>
        </div>
      </form>
    </section>
  );
}
