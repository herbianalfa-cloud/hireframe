import { FACT_TYPES } from '@hireframe/shared';
import {
  Archive,
  ArchiveRestore,
  History,
  Pencil,
  TriangleAlert,
  UserRoundPlus,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  archiveFact,
  unarchiveFact,
  writeErrorMessage,
  type FactView,
  type LiveState,
} from '@/services/profile';

import { EditFactDialog } from './EditFactDialog';
import { HistorySheet } from './HistorySheet';
import { formatFactDates, LANE_LABELS, sourceLabel, TYPE_LABELS } from './labels';

type Tab = 'active' | 'archived';

function matches(view: FactView, query: string): boolean {
  const { fact } = view;
  return [fact.text, fact.evidence, ...fact.tags].some((value) =>
    value.toLowerCase().includes(query),
  );
}

function FactRow({
  view,
  onEdit,
  onHistory,
}: {
  view: FactView;
  onEdit: (view: FactView) => void;
  onHistory: (view: FactView) => void;
}) {
  const { fact } = view;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const archived = fact.status === 'archived';
  const dates = formatFactDates(fact.dates);

  async function toggleArchive() {
    setPending(true);
    setError(undefined);
    try {
      await (archived ? unarchiveFact(view) : archiveFact(view));
    } catch (caught) {
      setError(writeErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="p-3 md:p-4">
      <p className="text-sm">{fact.text}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge>{TYPE_LABELS[fact.type].singular}</Badge>
        <Badge variant={fact.source === 'cv' ? 'accent' : 'default'}>{sourceLabel(fact)}</Badge>
        {fact.lanes.map((lane) => (
          <Badge key={lane}>{LANE_LABELS[lane]}</Badge>
        ))}
        {dates ? <span className="font-mono text-xs text-muted-foreground">{dates}</span> : null}
      </div>
      {!fact.evidenceVerified ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-verdict-near-miss">
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          {fact.source === 'cv' ? 'Quote not found in the CV' : 'Quote not found in your text'}
        </p>
      ) : null}
      <details className="mt-1 text-xs text-muted-foreground">
        <summary className="flex min-h-11 cursor-pointer items-center">Evidence</summary>
        <blockquote className="border-l-2 pl-3 pb-2">{fact.evidence}</blockquote>
      </details>
      <div className="mt-1 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            onEdit(view);
          }}
        >
          <Pencil aria-hidden="true" />
          Edit
        </Button>
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => {
            void toggleArchive();
          }}
        >
          {archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
          {archived ? 'Unarchive' : 'Archive'}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            onHistory(view);
          }}
        >
          <History aria-hidden="true" />
          History
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed bg-surface px-6 py-12 text-center">
      <UserRoundPlus aria-hidden="true" className="size-6 text-muted-foreground" />
      <h3 className="mt-3 text-sm font-medium">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

/** The fact library: Active / Archived, searchable, grouped by type. */
export function FactList({ state }: { state: LiveState<FactView[]> }) {
  const [tab, setTab] = useState<Tab>('active');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<FactView | null>(null);
  const [historyFor, setHistoryFor] = useState<FactView | null>(null);

  const facts = state.status === 'ready' ? state.data : undefined;
  const counts = useMemo(
    () => ({
      active: facts?.filter((view) => view.fact.status === 'active').length ?? 0,
      archived: facts?.filter((view) => view.fact.status === 'archived').length ?? 0,
    }),
    [facts],
  );
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      (facts ?? []).filter(
        (view) => view.fact.status === tab && (needle === '' || matches(view, needle)),
      ),
    [facts, tab, needle],
  );

  if (state.status === 'loading') {
    return (
      <div role="status" aria-label="Loading facts" className="space-y-3">
        <Skeleton className="h-11" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div
        role="alert"
        className="rounded-lg border border-danger/40 bg-surface p-4 text-sm text-danger"
      >
        {state.message}
      </div>
    );
  }
  if (state.data.length === 0) {
    return (
      <Empty
        title="No facts yet"
        body="Upload your CV above or add a fact by hand. Every verdict and tailored CV draws on these."
      />
    );
  }

  return (
    <section aria-labelledby="facts-title">
      <h2 id="facts-title" className="text-sm font-medium">
        Facts
      </h2>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="group" aria-label="Show" className="flex gap-1 rounded-md border bg-surface p-1">
          {(['active', 'archived'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={tab === value}
              onClick={() => {
                setTab(value);
              }}
              className={cn(
                'min-h-11 flex-1 rounded-sm px-4 text-sm transition-colors duration-150 ease-out sm:flex-none',
                tab === value
                  ? 'bg-surface-raised font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {value === 'active' ? 'Active' : 'Archived'} ({counts[value]})
            </button>
          ))}
        </div>
        <div className="sm:w-72">
          <Label htmlFor="fact-search" className="sr-only">
            Search facts
          </Label>
          <Input
            id="fact-search"
            type="search"
            placeholder="Search text, evidence, tags"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
      </div>

      <div className="mt-4 space-y-6">
        {visible.length === 0 ? (
          <Empty
            title={
              needle
                ? 'No matching facts'
                : tab === 'active'
                  ? 'No active facts'
                  : 'No archived facts'
            }
            body={
              needle
                ? 'Try a different search.'
                : tab === 'active'
                  ? 'Restore an archived fact or add a new one.'
                  : 'Facts you archive are kept here and can be restored.'
            }
          />
        ) : (
          FACT_TYPES.map((type) => {
            const group = visible.filter((view) => view.fact.type === type);
            if (group.length === 0) return null;
            const headingId = `group-${type}`;
            return (
              <section key={type} aria-labelledby={headingId}>
                <h3
                  id={headingId}
                  className="mb-2 text-xs font-medium text-muted-foreground uppercase"
                >
                  {TYPE_LABELS[type].plural} ({group.length})
                </h3>
                <ul className="divide-y rounded-lg border bg-surface">
                  {group.map((view) => (
                    <FactRow
                      key={view.id}
                      view={view}
                      onEdit={setEditing}
                      onHistory={setHistoryFor}
                    />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
      {state.invalid > 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {state.invalid} {state.invalid === 1 ? 'fact' : 'facts'} could not be read and{' '}
          {state.invalid === 1 ? 'is' : 'are'} hidden.
        </p>
      ) : null}

      <EditFactDialog
        view={editing}
        onClose={() => {
          setEditing(null);
        }}
      />
      <HistorySheet
        view={historyFor}
        onClose={() => {
          setHistoryFor(null);
        }}
      />
    </section>
  );
}
