import { FACT_LIMITS } from '@hireframe/shared';
import { Loader2, Plus } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { addFact, callableErrorMessage } from '@/services/profile';

type Result = { kind: 'ok'; text: string } | { kind: 'error'; text: string };

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** Free-text "add a fact": the model turns it into up to five atomic facts. */
export function AddFactForm() {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result>();

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setPending(true);
    setResult(undefined);
    try {
      const { added, skippedDuplicates } = await addFact(text);
      const parts = [`Added ${plural(added.length, 'fact')}`];
      if (skippedDuplicates > 0) parts.push(`${String(skippedDuplicates)} already in your profile`);
      setResult({ kind: 'ok', text: parts.join(' · ') });
      setText('');
    } catch (error) {
      setResult({ kind: 'error', text: callableErrorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="add-title" className="rounded-lg border bg-surface p-4 md:p-5">
      <h2 id="add-title" className="text-sm font-medium">
        Add a fact
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Write anything about your work, skills or preferences. It is split into separate facts you
        can edit later.
      </p>
      <form
        onSubmit={(event) => {
          void onSubmit(event);
        }}
        className="mt-3"
      >
        <Field label="New fact">
          {(control) => (
            <Textarea
              {...control}
              value={text}
              maxLength={FACT_LIMITS.addFactInput}
              disabled={pending}
              placeholder="e.g. Led a three-person team shipping a booking tool in 2023"
              onChange={(event) => {
                setText(event.target.value);
              }}
            />
          )}
        </Field>
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="font-mono text-xs text-muted-foreground tabular-nums">
            {text.length}/{FACT_LIMITS.addFactInput}
          </p>
          <Button type="submit" disabled={pending || !text.trim()}>
            {pending ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <Plus aria-hidden="true" />
            )}
            {pending ? 'Adding…' : 'Add fact'}
          </Button>
        </div>
      </form>
      <div aria-live="polite" className="mt-2 text-sm empty:mt-0">
        {result ? (
          <p className={result.kind === 'error' ? 'text-danger' : 'text-foreground'}>
            {result.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}
