import { LOOKUP_LIMITS, type LookupDescribeResult } from '@hireframe/shared';
import { Loader2 } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { lookupDescribe, lookupErrorMessage } from '@/services/lookup';

import { describeText } from './model';

/**
 * Paste a job's description to have it judged (ADR-049): for a job waiting at "needs a
 * description", whether Lookup added it or an email alert did. The text goes to the `lookup`
 * callable, which runs the rules and the deep read on it. It costs a few pence, so it is sent
 * once per press and never retried here. Used on the Lookup screen and in the job sheet.
 */
export function PasteDescription({
  jobId,
  onResult,
  onCancel,
}: {
  jobId: string;
  onResult?: (result: LookupDescribeResult) => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string }>();
  const tooLong = text.length > LOOKUP_LIMITS.description;

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (pending || !text.trim() || tooLong) return;
    setPending(true);
    setMessage(undefined);
    try {
      const result = await lookupDescribe(jobId, text);
      setMessage({ kind: 'ok', text: describeText(result) });
      if (result.status !== 'refused') setText('');
      onResult?.(result);
    } catch (error) {
      setMessage({ kind: 'error', text: lookupErrorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3">
      <Field
        label="Job description"
        hint="Copy the whole posting from the job page and paste it here."
        error={
          tooLong
            ? `Too long by ${(text.length - LOOKUP_LIMITS.description).toLocaleString('en-GB')} characters.`
            : undefined
        }
      >
        {(control) => (
          <Textarea
            {...control}
            value={text}
            rows={8}
            disabled={pending}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending || !text.trim() || tooLong}>
          {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          {pending ? 'Judging…' : 'Judge'}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {text.length.toLocaleString('en-GB')} /{' '}
          {LOOKUP_LIMITS.description.toLocaleString('en-GB')}
        </span>
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
