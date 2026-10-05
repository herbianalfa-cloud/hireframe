import type { DiagnosticsReport, SkipReasonCounts } from '@hireframe/shared';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DIAGNOSTICS_DAYS,
  diagnosticsErrorMessage,
  loadDiagnostics,
} from '@/services/funnel-diagnostics';

/**
 * "S2 skip reasons" (docs/plans/funnel-intake-plan.md, ADR-043): counts of why S2 skipped jobs
 * and what each candidate S1 rule would have caught, read on demand from the owner's own data.
 * Numbers and names only; no job title, company, note or text is shown or copied.
 */

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; report: DiagnosticsReport }
  | { status: 'error'; message: string };

const SET_LABELS = {
  s2Skipped: 'S2 skips (model)',
  good: 'Good jobs',
  queuedS3: 'Waiting for S3',
} as const;

const BLOCKER_LABELS: Record<string, string> = {
  right_to_work: 'right to work',
};
const label = (key: string): string => BLOCKER_LABELS[key] ?? key.replace(/_/g, ' ');

function CountTable({
  caption,
  rows,
  head = 'Value',
}: {
  caption: string;
  rows: readonly [string, number][];
  head?: string;
}) {
  return (
    <table className="w-full text-sm">
      <caption className="mb-1 text-left text-xs text-muted-foreground">{caption}</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">{head}</th>
          <th scope="col">Jobs</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, value]) => (
          <tr key={name} className="border-t">
            <th scope="row" className="py-1 pr-2 text-left font-normal">
              {label(name)}
            </th>
            <td className="py-1 text-right font-mono tabular-nums">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const nonZero = (counts: Record<string, number>): [string, number][] =>
  Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1]);

function Skips({ counts }: { counts: SkipReasonCounts }) {
  return (
    <div className="mt-4 grid gap-6 sm:grid-cols-2">
      <CountTable caption="By lane" rows={nonZero(counts.byLane)} head="Lane" />
      <CountTable caption="By seniority" rows={nonZero(counts.bySeniority)} head="Seniority" />
      <CountTable
        caption="By lane and seniority"
        rows={nonZero(counts.byLaneSeniority)}
        head="Lane and seniority"
      />
      <CountTable
        caption={`By blocker category (${String(counts.withoutBlockers)} skips list none)`}
        rows={nonZero(counts.byBlocker)}
        head="Blocker"
      />
    </div>
  );
}

function RuleHits({ report }: { report: DiagnosticsReport }) {
  const { sets } = report;
  return (
    <table className="mt-2 w-full text-sm">
      <caption className="mb-1 text-left text-xs text-muted-foreground">
        Jobs each candidate rule would have skipped at S1, out of the set size
      </caption>
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th scope="col" className="py-1 font-normal">
            Rule
          </th>
          {(Object.keys(SET_LABELS) as (keyof typeof SET_LABELS)[]).map((name) => (
            <th key={name} scope="col" className="py-1 text-right font-normal">
              {SET_LABELS[name]} of {sets[name].size}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Object.entries(report.candidateHits).map(([id, hits]) => (
          <tr key={id} className="border-t">
            <th scope="row" className="py-1 text-left font-mono font-normal">
              {id}
            </th>
            <td className="py-1 text-right font-mono tabular-nums">{hits.s2Skipped}</td>
            <td className="py-1 text-right font-mono tabular-nums">{hits.good}</td>
            <td className="py-1 text-right font-mono tabular-nums">{hits.queuedS3}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Report({ report }: { report: DiagnosticsReport }) {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  }
  const range = (name: keyof typeof SET_LABELS) => {
    const { size, from, to } = report.sets[name];
    return from && to ? `${from} to ${to}` : size === 0 ? 'none' : 'no dates';
  };
  return (
    <div className="mt-4">
      <table className="w-full text-sm">
        <caption className="mb-1 text-left text-xs text-muted-foreground">
          What was read: the size of each set and the dates it covers
        </caption>
        <tbody>
          {(Object.keys(SET_LABELS) as (keyof typeof SET_LABELS)[]).map((name) => (
            <tr key={name} className="border-t">
              <th scope="row" className="py-1 text-left font-normal">
                {SET_LABELS[name]}
              </th>
              <td className="py-1 text-right font-mono tabular-nums">{report.sets[name].size}</td>
              <td className="py-1 text-right font-mono text-xs text-muted-foreground">
                {range(name)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Skips counts={report.s2Skips} />
      <h3 className="mt-6 text-sm font-medium">Candidate S1 rules</h3>
      <RuleHits report={report} />
      <p className="mt-4 text-xs text-muted-foreground">
        Queued without a sort date (never read by a stage or the sweep): S2{' '}
        <span className="font-mono">{report.queuedWithoutSortAt.s2 ?? '?'}</span>, S3{' '}
        <span className="font-mono">{report.queuedWithoutSortAt.s3 ?? '?'}</span>
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" onClick={() => void copy()}>
          Copy counts
        </Button>
        <span role="status" className="text-xs text-muted-foreground">
          {copied === 'ok' ? 'Copied.' : copied === 'failed' ? "Couldn't copy." : ''}
        </span>
      </div>
    </div>
  );
}

export function S2SkipReasons() {
  const [state, setState] = useState<State>({ status: 'idle' });
  async function load() {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', report: await loadDiagnostics(new Date()) });
    } catch (error) {
      setState({ status: 'error', message: diagnosticsErrorMessage(error) });
    }
  }
  return (
    <section aria-labelledby="s2-skips-title" className="mt-8">
      <h2 id="s2-skips-title" className="text-sm font-medium">
        S2 skip reasons
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Counts only, from the last {DIAGNOSTICS_DAYS} days: why S2 skipped jobs, and what each
        candidate S1 rule would have caught. Reads up to about 1,500 jobs when you press Load.
      </p>
      <div className="mt-3">
        <Button
          type="button"
          variant="secondary"
          disabled={state.status === 'loading'}
          onClick={() => void load()}
        >
          {state.status === 'ready' ? 'Reload' : 'Load'}
        </Button>
      </div>
      {state.status === 'loading' ? <Skeleton className="mt-4 h-24 w-full" /> : null}
      {state.status === 'error' ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {state.message}
        </p>
      ) : null}
      {state.status === 'ready' ? <Report report={state.report} /> : null}
    </section>
  );
}
