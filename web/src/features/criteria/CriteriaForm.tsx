import { CriteriaContentSchema, type CriteriaVersion } from '@hireframe/shared';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useState, type SubmitEvent, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ListEditor } from '@/components/ui/list-editor';
import { criteriaErrorMessage, saveCriteria } from '@/services/criteria';

import { HistoryList } from './HistoryList';
import {
  errorAt,
  newRowKey,
  toContent,
  toDraft,
  toFieldErrors,
  type Draft,
  type TitleRow,
} from './model';

interface Message {
  kind: 'ok' | 'error';
  text: string;
}

function Section({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="rounded-lg border bg-surface p-4 md:p-5">
      <h2 id={id} className="text-sm font-medium">
        {title}
      </h2>
      {hint ? <p className="mt-1 text-sm text-muted-foreground">{hint}</p> : null}
      <div className="mt-4 space-y-5">{children}</div>
    </section>
  );
}

function NumberField({
  label,
  value,
  onChange,
  error,
  step = 1,
  min,
  max,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
  step?: number;
  min: number;
  max?: number;
  hint?: string;
}) {
  return (
    <Field label={label} error={error} {...(hint ? { hint } : {})}>
      {(control) => (
        <Input
          {...control}
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          max={max}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </Field>
  );
}

function ExcludedTitles({
  rows,
  onChange,
  errors,
}: {
  rows: TitleRow[];
  onChange: (rows: TitleRow[]) => void;
  errors: Record<string, string>;
}) {
  const [term, setTerm] = useState('');
  const [addError, setAddError] = useState<string>();

  function add() {
    const value = term.trim();
    if (!value) return;
    if (rows.some((row) => row.term.toLowerCase() === value.toLowerCase())) {
      setAddError(`"${value}" is already excluded.`);
      return;
    }
    onChange([...rows, { key: newRowKey(), id: undefined, term: value, prefixes: [] }]);
    setTerm('');
    setAddError(undefined);
  }

  function update(key: string, patch: Partial<TitleRow>) {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  return (
    <div>
      {rows.length > 0 ? (
        <ul className="space-y-3">
          {rows.map((row, index) => (
            <li
              key={row.key}
              role="group"
              aria-label={`Excluded title ${row.term || String(index + 1)}`}
              className="rounded-md border bg-surface-raised p-3"
            >
              <div className="flex items-end gap-2">
                <Field
                  label="Title term"
                  className="min-w-0 flex-1"
                  error={errorAt(errors, `excluded_titles.${String(index)}.term`)}
                >
                  {(control) => (
                    <Input
                      {...control}
                      value={row.term}
                      maxLength={120}
                      onChange={(event) => {
                        update(row.key, { term: event.target.value });
                      }}
                    />
                  )}
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove excluded title ${row.term || String(index + 1)}`}
                  onClick={() => {
                    onChange(rows.filter((other) => other.key !== row.key));
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
              <ListEditor
                className="mt-3"
                label="Allowed when preceded by"
                items={row.prefixes}
                placeholder="e.g. Junior"
                onChange={(prefixes) => {
                  update(row.key, { prefixes });
                }}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No excluded titles.</p>
      )}
      <div className="mt-3 flex items-end gap-2">
        <Field label="Exclude a title" className="min-w-0 flex-1" error={addError}>
          {(control) => (
            <Input
              {...control}
              value={term}
              maxLength={120}
              placeholder="Type and press Enter"
              onChange={(event) => {
                setTerm(event.target.value);
                setAddError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                add();
              }}
            />
          )}
        </Field>
        <Button
          type="button"
          variant="secondary"
          disabled={!term.trim()}
          onClick={add}
          aria-label="Add excluded title"
        >
          <Plus aria-hidden="true" />
          Add
        </Button>
      </div>
    </div>
  );
}

/** The editable criteria document (PRD R3). Saving writes a new immutable version. */
export function CriteriaForm({ criteria }: { criteria: CriteriaVersion }) {
  const [baseline, setBaseline] = useState(() => toDraft(criteria));
  const [draft, setDraft] = useState(baseline);
  const [basedOn, setBasedOn] = useState(criteria.version);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<Message>();
  const [saving, setSaving] = useState(false);

  const dirty = JSON.stringify(toContent(draft)) !== JSON.stringify(toContent(baseline));

  function edit(patch: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setMessage(undefined);
  }

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    const parsed = CriteriaContentSchema.safeParse(toContent(draft));
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error.issues));
      setMessage({ kind: 'error', text: 'Some values are invalid. Check the highlighted fields.' });
      return;
    }
    setErrors({});
    setSaving(true);
    setMessage(undefined);
    try {
      const version = await saveCriteria(parsed.data, basedOn);
      const saved = toDraft(parsed.data);
      setBaseline(saved);
      setDraft(saved);
      setBasedOn(version);
      setMessage({ kind: 'ok', text: `Saved as version ${String(version)}` });
    } catch (error) {
      setMessage({ kind: 'error', text: criteriaErrorMessage(error) });
    } finally {
      setSaving(false);
    }
  }

  const thresholds = draft.thresholds;

  return (
    <section aria-labelledby="page-title" className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h1 id="page-title" className="text-xl font-semibold tracking-tight">
          Criteria
        </h1>
        <p className="font-mono text-sm text-muted-foreground tabular-nums">Version {basedOn}</p>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        What the funnel judges jobs against. Each save creates a new version.
      </p>

      <form
        noValidate
        onSubmit={(event) => {
          void onSubmit(event);
        }}
        className="mt-6 space-y-6"
      >
        <Section id="lanes-title" title="Target lanes" hint="Job titles you want, by priority.">
          {(['primary', 'secondary', 'opportunistic'] as const).map((lane) => (
            <ListEditor
              key={lane}
              label={
                lane === 'primary'
                  ? 'Primary'
                  : lane === 'secondary'
                    ? 'Secondary'
                    : 'Opportunistic'
              }
              items={draft.lanes[lane]}
              error={errorAt(errors, `lanes.${lane}`)}
              onChange={(items) => {
                edit({ lanes: { ...draft.lanes, [lane]: items } });
              }}
            />
          ))}
        </Section>

        <Section
          id="wildcards-title"
          title="Wildcard interests"
          hint="Off-lane roles worth a look."
        >
          <ListEditor
            label="Wildcard interests"
            items={draft.wildcards}
            error={errorAt(errors, 'wildcards')}
            onChange={(items) => {
              edit({ wildcards: items });
            }}
          />
        </Section>

        <Section
          id="exclusions-title"
          title="Exclusions"
          hint="Jobs matching these are skipped before scoring."
        >
          <div>
            <h3 className="mb-2 text-sm font-medium">Excluded titles</h3>
            <ExcludedTitles
              rows={draft.excludedTitles}
              errors={errors}
              onChange={(rows) => {
                edit({ excludedTitles: rows });
              }}
            />
          </div>
          <ListEditor
            label="Excluded keywords"
            items={draft.excludedKeywords}
            error={errorAt(errors, 'excluded_keywords')}
            onChange={(items) => {
              edit({ excludedKeywords: items });
            }}
          />
          <ListEditor
            label="Excluded companies"
            items={draft.excludedCompanies}
            error={errorAt(errors, 'excluded_companies')}
            onChange={(items) => {
              edit({ excludedCompanies: items });
            }}
          />
          <ListEditor
            label="Blockers"
            hint="Requirements you can not meet, such as a clearance."
            items={draft.blockers}
            error={errorAt(errors, 'blockers')}
            onChange={(items) => {
              edit({ blockers: items });
            }}
          />
          <NumberField
            label="Experience cap (years)"
            hint="Skip roles asking for more than this."
            value={draft.experienceCapYears}
            min={0}
            max={20}
            error={errorAt(errors, 'experience_cap_years')}
            onChange={(value) => {
              edit({ experienceCapYears: value });
            }}
          />
        </Section>

        <Section id="locations-title" title="Locations">
          <ListEditor
            label="Preferred locations"
            items={draft.locations.preferred}
            error={errorAt(errors, 'locations.preferred')}
            onChange={(items) => {
              edit({ locations: { ...draft.locations, preferred: items } });
            }}
          />
          <ListEditor
            label="Accepted locations"
            items={draft.locations.accepted}
            error={errorAt(errors, 'locations.accepted')}
            onChange={(items) => {
              edit({ locations: { ...draft.locations, accepted: items } });
            }}
          />
        </Section>

        <Section id="company-title" title="Company preferences">
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              label="Company size, minimum"
              hint="Number of employees."
              value={draft.sizeMin}
              min={1}
              error={errorAt(errors, 'company_prefs.size')}
              onChange={(value) => {
                edit({ sizeMin: value });
              }}
            />
            <NumberField
              label="Company size, maximum"
              value={draft.sizeMax}
              min={1}
              error={undefined}
              onChange={(value) => {
                edit({ sizeMax: value });
              }}
            />
          </div>
          <ListEditor
            label="Stages"
            items={draft.stages}
            error={errorAt(errors, 'company_prefs.stages')}
            onChange={(items) => {
              edit({ stages: items });
            }}
          />
          <ListEditor
            label="Sectors to boost"
            items={draft.sectorsBoost}
            error={errorAt(errors, 'company_prefs.sectors_boost')}
            onChange={(items) => {
              edit({ sectorsBoost: items });
            }}
          />
          <ListEditor
            label="Sectors to penalise"
            items={draft.sectorsPenalise}
            error={errorAt(errors, 'company_prefs.sectors_penalise')}
            onChange={(items) => {
              edit({ sectorsPenalise: items });
            }}
          />
        </Section>

        <Section id="rules-title" title="Freshness, thresholds and target">
          <NumberField
            label="Freshness window (days)"
            hint="Ignore postings older than this."
            value={draft.freshnessDays}
            min={1}
            max={90}
            error={errorAt(errors, 'freshness_days')}
            onChange={(value) => {
              edit({ freshnessDays: value });
            }}
          />
          <div>
            <h3 className="text-sm font-medium">Verdict thresholds</h3>
            <p className="mt-1 text-xs text-muted-foreground">Scores from 0 to 10.</p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <NumberField
                label="Apply: minimum fit"
                value={thresholds.applyFit}
                min={0}
                max={10}
                step={0.5}
                error={errorAt(errors, 'thresholds.apply_fit')}
                onChange={(value) => {
                  edit({ thresholds: { ...thresholds, applyFit: value } });
                }}
              />
              <NumberField
                label="Apply: minimum luck"
                value={thresholds.applyLuck}
                min={0}
                max={10}
                step={0.5}
                error={errorAt(errors, 'thresholds.apply_luck')}
                onChange={(value) => {
                  edit({ thresholds: { ...thresholds, applyLuck: value } });
                }}
              />
              <NumberField
                label="Near miss: minimum fit"
                value={thresholds.nearMissFit}
                min={0}
                max={10}
                step={0.5}
                error={errorAt(errors, 'thresholds.near_miss_fit')}
                onChange={(value) => {
                  edit({ thresholds: { ...thresholds, nearMissFit: value } });
                }}
              />
              <NumberField
                label="Wildcard: minimum fit"
                value={thresholds.wildcardFit}
                min={0}
                max={10}
                step={0.5}
                error={errorAt(errors, 'thresholds.wildcard_fit')}
                onChange={(value) => {
                  edit({ thresholds: { ...thresholds, wildcardFit: value } });
                }}
              />
            </div>
          </div>
          <NumberField
            label="Weekly application target"
            value={draft.weeklyTarget}
            min={1}
            max={100}
            error={errorAt(errors, 'weekly_target')}
            onChange={(value) => {
              edit({ weeklyTarget: value });
            }}
          />
        </Section>

        <div className="sticky bottom-14 z-10 flex flex-wrap items-center gap-3 rounded-lg border bg-surface p-3 md:bottom-4">
          <div aria-live="polite" className="min-w-0 flex-1 text-sm">
            {message ? (
              <p className={message.kind === 'error' ? 'text-danger' : 'text-foreground'}>
                {message.text}
              </p>
            ) : dirty ? (
              <p className="text-muted-foreground">Unsaved changes</p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(baseline);
              setErrors({});
              setMessage(undefined);
            }}
          >
            Discard changes
          </Button>
          <Button type="submit" disabled={!dirty || saving}>
            {saving ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </form>

      <div className="mt-6">
        <HistoryList currentVersion={criteria.version} />
      </div>
    </section>
  );
}
