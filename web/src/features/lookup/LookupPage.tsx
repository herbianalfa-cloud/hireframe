import {
  LOOKUP_LIMITS,
  parseLookupInput,
  parseResultsPage,
  type LookupJobInput,
  type LookupOutcome,
  type LookupRow,
  type LookupTarget,
  type PasteLink,
} from '@hireframe/shared';
import { Loader2, Search } from 'lucide-react';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useSearchParams } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { JobDetail } from '@/features/jobs/JobDetail';
import type { JobView } from '@/services/jobs';
import {
  lookupAdd,
  lookupErrorMessage,
  lookupParse,
  matchRows,
  matchTargets,
} from '@/services/lookup';

import { ManualAdd } from './ManualAdd';
import { busyText, capText, outcomeText } from './model';
import { extractJobAnchors } from './pasteAnchors';
import { RowsPreview, type PreviewRow } from './RowsPreview';
import { SeenLine } from './SeenLine';
import { WaitingList } from './WaitingList';

interface Checked {
  targets: { target: LookupTarget; view: JobView | null }[];
  rows: PreviewRow[];
  /** A long paste neither parser could read: the owner may ask the model once. */
  unreadable: boolean;
}

type CheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'error'; message: string }
  | { status: 'ready'; checked: Checked };

type AddState =
  | { status: 'idle' }
  | { status: 'adding' }
  | { status: 'busy'; message: string }
  | { status: 'error'; message: string }
  | {
      status: 'done';
      entries: { label: string; outcome: LookupOutcome }[];
      note: string | null;
    };

/** A paste this long that no parser reads is worth one cheap model call. */
const UNREADABLE_MIN_CHARS = 200;

const jobIdOf = (outcome: LookupOutcome): string | undefined =>
  'jobId' in outcome ? outcome.jobId : undefined;

/**
 * Lookup (PRD R8, ADR-049): paste job links to see whether they've been seen and what the
 * verdict was, or paste a LinkedIn results page to add the jobs you haven't seen. Checking costs
 * nothing and works during a scan. Adding runs the funnel on the spot, within a daily limit.
 * Nothing is fetched from LinkedIn: only the text you paste is read.
 */
export function LookupPage() {
  const [params, setParams] = useSearchParams();
  const jobId = params.get('job');
  const [text, setText] = useState('');
  const [links, setLinks] = useState<PasteLink[]>([]);
  const [check, setCheck] = useState<CheckState>({ status: 'idle' });
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [add, setAdd] = useState<AddState>({ status: 'idle' });
  const [modelReading, setModelReading] = useState(false);
  /** A cap note from the model read of a page, shown with the checked results. */
  const [parseNote, setParseNote] = useState<string | null>(null);
  const [now] = useState(() => new Date());
  const resultsRef = useRef<HTMLHeadingElement>(null);

  // After an add, focus moves to its results so a screen reader reads them.
  const addStatus = add.status;
  useEffect(() => {
    if (addStatus === 'done' || addStatus === 'busy' || addStatus === 'error') {
      resultsRef.current?.focus();
    }
  }, [addStatus]);

  const open = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('job', id);
    setParams(next);
  };

  async function onCheck(event: SubmitEvent) {
    event.preventDefault();
    if (!text.trim() || check.status === 'checking') return;
    setCheck({ status: 'checking' });
    setAdd({ status: 'idle' });
    setParseNote(null);
    try {
      const targets = parseLookupInput(text);
      const rows = parseResultsPage(text, links);
      const [targetViews, rowViews] = await Promise.all([matchTargets(targets), matchRows(rows)]);
      setPicked(new Set(rowViews.flatMap((view, index) => (view ? [] : [index]))));
      setCheck({
        status: 'ready',
        checked: {
          targets: targets.map((target, index) => ({ target, view: targetViews[index] ?? null })),
          rows: rows.map((row, index) => ({ row, view: rowViews[index] ?? null })),
          unreadable:
            targets.length === 0 && rows.length === 0 && text.length >= UNREADABLE_MIN_CHARS,
        },
      });
    } catch {
      setCheck({
        status: 'error',
        message: "Couldn't check. Check your connection and try again.",
      });
    }
  }

  async function readWithModel() {
    if (modelReading) return;
    setModelReading(true);
    try {
      const parsed = await lookupParse(text, links.slice(0, LOOKUP_LIMITS.links));
      const views = await matchRows(parsed.rows);
      setPicked(new Set(views.flatMap((view, index) => (view ? [] : [index]))));
      setCheck({
        status: 'ready',
        checked: {
          targets: [],
          rows: parsed.rows.map((row, index) => ({ row, view: views[index] ?? null })),
          unreadable: false,
        },
      });
      setParseNote(capText(parsed.capReached));
    } catch (error) {
      setCheck({ status: 'error', message: lookupErrorMessage(error) });
    } finally {
      setModelReading(false);
    }
  }

  async function addJobs(inputs: LookupJobInput[], labels: string[]) {
    setAdd({ status: 'adding' });
    try {
      const result = await lookupAdd(inputs);
      if (result.status === 'busy') {
        setAdd({ status: 'busy', message: busyText(result.retryAfterSeconds) });
        return;
      }
      setAdd({
        status: 'done',
        entries: result.outcomes.map((outcome, index) => ({
          label: labels[index] ?? 'Job',
          outcome,
        })),
        note: capText(result.capReached),
      });
    } catch (error) {
      setAdd({ status: 'error', message: lookupErrorMessage(error) });
    }
  }

  const ready = check.status === 'ready' ? check.checked : null;
  const nothingFound =
    ready !== null && ready.targets.length === 0 && ready.rows.length === 0 && !ready.unreadable;
  const tooLong = text.length > LOOKUP_LIMITS.pasteChars;

  return (
    <section aria-labelledby="page-title" className="mx-auto max-w-5xl">
      <h1 id="page-title" className="text-xl font-semibold tracking-tight">
        Lookup
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Paste job links to see whether Hireframe has seen them, or copy a LinkedIn search results
        page (select all, copy) to add the jobs it hasn&apos;t. Nothing is fetched from LinkedIn.
      </p>

      <form onSubmit={(event) => void onCheck(event)} className="mt-5 space-y-3">
        <Field
          label="Links or a results page"
          hint="One link per line, or a whole results page pasted as it is."
          error={tooLong ? 'This is too long. Paste fewer jobs at a time.' : undefined}
        >
          {(control) => (
            <Textarea
              {...control}
              rows={6}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                if (event.target.value === '') {
                  setLinks([]);
                  setCheck({ status: 'idle' });
                }
              }}
              onPaste={(event) => {
                // The page's links come from the pasted HTML; the text itself pastes as usual.
                setLinks(extractJobAnchors(event.clipboardData.getData('text/html')));
              }}
            />
          )}
        </Field>
        <Button type="submit" disabled={!text.trim() || tooLong || check.status === 'checking'}>
          {check.status === 'checking' ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <Search aria-hidden="true" />
          )}
          {check.status === 'checking' ? 'Checking…' : 'Check'}
        </Button>
      </form>

      <div aria-live="polite" className="mt-6">
        {check.status === 'error' ? (
          <p role="alert" className="text-sm text-danger">
            {check.message}
          </p>
        ) : null}
        {nothingFound ? (
          <p className="rounded-lg border border-dashed bg-surface px-4 py-6 text-center text-sm text-muted-foreground">
            No job links or results-page jobs found in this text.
          </p>
        ) : null}
        {parseNote ? <p className="text-sm">{parseNote}</p> : null}
        {ready?.unreadable ? (
          <div className="rounded-lg border bg-surface p-4 text-sm">
            <p>Hireframe couldn&apos;t read jobs from this text.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              A small model call can try to read it. It costs a fraction of a penny and counts
              toward today&apos;s Lookup limit.
            </p>
            <Button
              className="mt-3"
              variant="secondary"
              disabled={modelReading || tooLong}
              onClick={() => void readWithModel()}
            >
              {modelReading ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
              {modelReading ? 'Reading…' : 'Let the model try'}
            </Button>
          </div>
        ) : null}
      </div>

      {ready && ready.targets.length > 0 ? (
        <section aria-labelledby="checked-title" className="mt-6">
          <h2 id="checked-title" className="text-sm font-medium">
            Checked links
          </h2>
          <ul aria-label="Checked links" className="mt-2 divide-y rounded-lg border bg-surface">
            {ready.targets.map(({ target, view }) => (
              <li key={target.url} className="space-y-2 px-4 py-3">
                <p className="font-mono text-xs break-all text-muted-foreground">{target.url}</p>
                {view ? (
                  <SeenLine view={view} onOpen={open} />
                ) : (
                  <div className="space-y-2">
                    <Badge>Not seen yet</Badge>
                    {target.ats ? (
                      <div>
                        <Button
                          variant="secondary"
                          disabled={add.status === 'adding'}
                          onClick={() => {
                            void addJobs([{ kind: 'url', url: target.url }], [target.url]);
                          }}
                        >
                          Add from the job board
                        </Button>
                        <p className="mt-1 text-xs text-muted-foreground">
                          The board&apos;s own public API is asked for the posting, then it is
                          judged.
                        </p>
                      </div>
                    ) : (
                      <ManualAdd
                        target={target}
                        onAdded={(id) => {
                          if (id) open(id);
                        }}
                      />
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {ready && ready.rows.length > 0 ? (
        <RowsPreview
          rows={ready.rows}
          picked={picked}
          adding={add.status === 'adding'}
          onPick={(index, on) => {
            setPicked((previous) => {
              const next = new Set(previous);
              if (on) next.add(index);
              else next.delete(index);
              return next;
            });
          }}
          onOpen={open}
          onAdd={() => {
            const chosen = ready.rows.flatMap(({ row }, index) => (picked.has(index) ? [row] : []));
            void addJobs(
              chosen.map((row: LookupRow) => ({ kind: 'row' as const, ...row })),
              chosen.map((row) => row.title),
            );
          }}
        />
      ) : null}

      <div aria-live="polite" className="mt-6">
        {add.status !== 'idle' && add.status !== 'adding' ? (
          <section aria-labelledby="added-title">
            <h2
              id="added-title"
              ref={resultsRef}
              tabIndex={-1}
              className="text-sm font-medium outline-none"
            >
              {add.status === 'done' ? 'Added' : 'Not added'}
            </h2>
            {add.status === 'busy' || add.status === 'error' ? (
              <p role="alert" className="mt-2 text-sm text-danger">
                {add.message}
              </p>
            ) : (
              <>
                {add.note ? <p className="mt-2 text-sm">{add.note}</p> : null}
                <ul aria-label="Results" className="mt-2 divide-y rounded-lg border bg-surface">
                  {add.entries.map((entry, index) => (
                    <li key={index} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
                      <span className="min-w-0 flex-1">
                        <span className="font-medium break-words">{entry.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {outcomeText(entry.outcome)}
                        </span>
                      </span>
                      {jobIdOf(entry.outcome) ? (
                        <Button
                          variant="secondary"
                          onClick={() => {
                            open(jobIdOf(entry.outcome) ?? '');
                          }}
                        >
                          Open job
                          <span className="sr-only">: {entry.label}</span>
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        ) : null}
        {add.status === 'adding' ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            Adding and judging. This can take a minute.
          </p>
        ) : null}
      </div>

      <WaitingList now={now} />

      {jobId ? (
        <JobDetail
          jobId={jobId}
          onClose={() => {
            const next = new URLSearchParams(params);
            next.delete('job');
            setParams(next);
          }}
        />
      ) : null}
    </section>
  );
}
