import {
  EvidenceUrlSchema,
  FACT_TYPES,
  FactContentSchema,
  LANES,
  type Fact,
} from '@hireframe/shared';
import { Loader2 } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { updateFact, writeErrorMessage, type FactView } from '@/services/profile';

import { LANE_LABELS, TYPE_LABELS } from './labels';

type FactPatch = Parameters<typeof updateFact>[1];
type Lane = Fact['lanes'][number];

interface FormState {
  type: Fact['type'];
  text: string;
  evidence: string;
  evidenceUrl: string;
  tags: string;
  lanes: readonly Lane[];
  start: string;
  end: string;
}

const FIELD_MESSAGES: Record<string, string> = {
  type: 'Choose a type.',
  text: 'Enter the fact, up to 500 characters.',
  evidence: 'Enter the supporting quote, up to 1000 characters.',
  evidenceUrl: 'Enter a full https:// link, up to 500 characters, or leave it empty.',
  tags: 'Use up to 20 tags, each up to 40 characters.',
  lanes: 'Choose from the listed lanes.',
  start: 'Use YYYY or YYYY-MM, for example 2021 or 2021-03.',
  end: 'Use YYYY, YYYY-MM or "present".',
};

function initialState(fact: Fact): FormState {
  return {
    type: fact.type,
    text: fact.text,
    evidence: fact.evidence,
    evidenceUrl: fact.evidenceUrl ?? '',
    tags: fact.tags.join(', '),
    lanes: fact.lanes,
    start: fact.dates.start ?? '',
    end: fact.dates.end ?? '',
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

function EditForm({ view, onClose }: { view: FactView; onClose: () => void }) {
  const { fact } = view;
  const [form, setForm] = useState(() => initialState(fact));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string>();
  const [pending, setPending] = useState(false);
  const evidenceEditable = fact.source === 'manual';

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    const start = form.start.trim();
    const endRaw = form.end.trim();
    const end = endRaw.toLowerCase() === 'present' ? 'present' : endRaw;
    const parsed = FactContentSchema.safeParse({
      type: form.type,
      text: form.text,
      evidence: evidenceEditable ? form.evidence : fact.evidence,
      dates: { ...(start ? { start } : {}), ...(end ? { end } : {}) },
      tags: form.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      lanes: form.lanes,
    });
    const evidenceUrl = form.evidenceUrl.trim();
    const urlValid = evidenceUrl === '' || EvidenceUrlSchema.safeParse(evidenceUrl).success;
    if (!parsed.success || !urlValid) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error?.issues ?? []) {
        const [first, second] = issue.path;
        const key = String(first === 'dates' ? second : first);
        next[key] ??= FIELD_MESSAGES[key] ?? issue.message;
      }
      if (!urlValid) next.evidenceUrl = FIELD_MESSAGES.evidenceUrl ?? '';
      setErrors(next);
      return;
    }
    setErrors({});

    // Send only what changed.
    const content = parsed.data;
    const patch: FactPatch = {};
    if (content.type !== fact.type) patch.type = content.type;
    if (content.text !== fact.text) patch.text = content.text;
    if (evidenceEditable && content.evidence !== fact.evidence) patch.evidence = content.evidence;
    if (evidenceUrl !== (fact.evidenceUrl ?? '')) patch.evidenceUrl = evidenceUrl || null;
    if (content.dates.start !== fact.dates.start || content.dates.end !== fact.dates.end) {
      patch.dates = content.dates;
    }
    if (content.tags.join('\n') !== fact.tags.join('\n')) patch.tags = content.tags;
    if (!sameSet(content.lanes, fact.lanes)) patch.lanes = content.lanes;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    setPending(true);
    setSaveError(undefined);
    try {
      await updateFact(view, patch);
      onClose();
    } catch (error) {
      setSaveError(writeErrorMessage(error));
      setPending(false);
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="mt-4 space-y-4"
    >
      <Field label="Type" error={errors.type}>
        {(control) => (
          <select
            {...control}
            value={form.type}
            onChange={(event) => {
              const next = FACT_TYPES.find((type) => type === event.target.value);
              if (next) set('type', next);
            }}
            className="h-11 w-full rounded-md border bg-background px-3 text-sm aria-invalid:border-danger"
          >
            {FACT_TYPES.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABELS[type].singular}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Text" error={errors.text}>
        {(control) => (
          <Textarea
            {...control}
            value={form.text}
            maxLength={500}
            onChange={(event) => {
              set('text', event.target.value);
            }}
          />
        )}
      </Field>
      <Field
        label="Evidence"
        error={errors.evidence}
        hint={evidenceEditable ? undefined : 'Quoted from your CV, so it can not be edited.'}
      >
        {(control) => (
          <Textarea
            {...control}
            value={form.evidence}
            readOnly={!evidenceEditable}
            maxLength={1000}
            onChange={(event) => {
              set('evidence', event.target.value);
            }}
          />
        )}
      </Field>
      <Field
        label="Evidence link"
        hint="Optional. A page that backs this up, for example a portfolio or certificate."
        error={errors.evidenceUrl}
      >
        {(control) => (
          <Input
            {...control}
            type="url"
            inputMode="url"
            value={form.evidenceUrl}
            placeholder="https://"
            maxLength={500}
            onChange={(event) => {
              set('evidenceUrl', event.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Tags" hint="Separate with commas. Up to 20." error={errors.tags}>
        {(control) => (
          <Input
            {...control}
            value={form.tags}
            onChange={(event) => {
              set('tags', event.target.value);
            }}
          />
        )}
      </Field>
      <fieldset>
        <legend className="text-sm font-medium">Lanes</legend>
        <div className="mt-1.5 flex flex-wrap gap-x-4">
          {LANES.map((lane) => (
            <label key={lane} className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-5 accent-accent"
                checked={form.lanes.includes(lane)}
                onChange={(event) => {
                  set(
                    'lanes',
                    event.target.checked
                      ? [...form.lanes, lane]
                      : form.lanes.filter((other) => other !== lane),
                  );
                }}
              />
              {LANE_LABELS[lane]}
            </label>
          ))}
        </div>
        {errors.lanes ? <p className="mt-1 text-xs text-danger">{errors.lanes}</p> : null}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Start date" hint="YYYY or YYYY-MM" error={errors.start}>
          {(control) => (
            <Input
              {...control}
              value={form.start}
              placeholder="2021-03"
              onChange={(event) => {
                set('start', event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="End date" hint='YYYY, YYYY-MM or "present"' error={errors.end}>
          {(control) => (
            <Input
              {...control}
              value={form.end}
              placeholder="present"
              onChange={(event) => {
                set('end', event.target.value);
              }}
            />
          )}
        </Field>
      </div>
      {saveError ? (
        <p role="alert" className="text-sm text-danger">
          {saveError}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          Save changes
        </Button>
      </div>
    </form>
  );
}

export function EditFactDialog({ view, onClose }: { view: FactView | null; onClose: () => void }) {
  return (
    <Dialog
      open={view !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Edit fact</DialogTitle>
        <DialogDescription>
          Changes are saved as a new version you can review later.
        </DialogDescription>
        {view ? <EditForm view={view} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}
