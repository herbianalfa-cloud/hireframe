import { type LookupDescribeResult } from '@hireframe/shared';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ageText, isSearchLink, SOURCE_NAMES } from '@/features/jobs/labels';
import type { JobView } from '@/services/jobs';
import { WAITING_PAGE_SIZE } from '@/services/lookup';

import { useWaitingJobs } from './hooks';
import { describeText } from './model';
import { PasteDescription } from './PasteDescription';

/** A LinkedIn view link opens the posting; a search link opens a search for it. */
function openLabel(url: string): string {
  if (isSearchLink(url)) return 'Search on LinkedIn';
  return /(^|\.)linkedin\.com$/.test(new URL(url).hostname) ? 'Open on LinkedIn' : 'Open posting';
}

function safeLabel(url: string): string {
  try {
    return openLabel(url);
  } catch {
    return 'Open posting';
  }
}

function WaitingRow({
  view,
  now,
  open,
  onToggle,
  onResult,
}: {
  view: JobView;
  now: Date;
  open: boolean;
  onToggle: () => void;
  onResult: (view: JobView, result: LookupDescribeResult) => void;
}) {
  const { job } = view;
  const source = job.sources[0] ? (SOURCE_NAMES[job.sources[0].id] ?? job.sources[0].id) : null;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{job.title}</p>
          <p className="text-xs text-muted-foreground">
            {job.company} · {job.location || 'Location not stated'} · {ageText(job, now)}
            {source ? ` · ${source}` : ''}
          </p>
        </div>
        <Button asChild variant="secondary">
          <a href={job.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden="true" />
            {safeLabel(job.url)}
            <span className="sr-only"> for {job.title} (opens in a new tab)</span>
          </a>
        </Button>
        <Button variant={open ? 'default' : 'secondary'} aria-expanded={open} onClick={onToggle}>
          Paste description
          <span className="sr-only"> for {job.title}</span>
        </Button>
      </div>
      {open ? (
        <div className="mt-3 border-t pt-3">
          <PasteDescription
            jobId={view.id}
            onResult={(result) => {
              onResult(view, result);
            }}
            onCancel={onToggle}
          />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Jobs waiting for a description (`next == 'description'`), whether Lookup added them or an
 * email alert did, newest first. Each row opens the posting and takes a pasted description.
 */
export function WaitingList({ now }: { now: Date }) {
  const [pageSize, setPageSize] = useState(WAITING_PAGE_SIZE);
  const state = useWaitingJobs(pageSize);
  const [openId, setOpenId] = useState<string>();
  const [notes, setNotes] = useState<{ id: string; text: string }[]>([]);
  return (
    <section aria-labelledby="waiting-title" className="mt-10">
      <h2 id="waiting-title" className="text-sm font-medium">
        Waiting for a description
        {state.status === 'ready' && state.data.length > 0 ? (
          <span className="ml-2 font-mono text-xs text-muted-foreground tabular-nums">
            {state.data.length}
            {state.data.length === pageSize ? '+' : ''}
          </span>
        ) : null}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        LinkedIn jobs from email alerts, and jobs you added, have no text to read. Open the posting,
        copy its description, and paste it here to have the job judged.
      </p>
      <div aria-live="polite">
        {notes.map((note) => (
          <p key={note.id} role="status" className="mt-2 text-sm">
            {note.text}
          </p>
        ))}
      </div>
      <div className="mt-3">
        {state.status === 'loading' ? (
          <div role="status" aria-label="Loading waiting jobs" className="space-y-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : state.status === 'error' ? (
          <p role="alert" className="text-sm text-danger">
            {state.message}
          </p>
        ) : state.data.length === 0 ? (
          <p className="rounded-lg border border-dashed bg-surface px-4 py-6 text-center text-sm text-muted-foreground">
            Nothing is waiting for a description.
          </p>
        ) : (
          <>
            <ul
              aria-label="Jobs waiting for a description"
              className="divide-y rounded-lg border bg-surface"
            >
              {state.data.map((view) => (
                <WaitingRow
                  key={view.id}
                  view={view}
                  now={now}
                  open={openId === view.id}
                  onToggle={() => {
                    setOpenId(openId === view.id ? undefined : view.id);
                  }}
                  onResult={(done, result) => {
                    setNotes((previous) => [
                      { id: done.id, text: `${done.job.title}: ${describeText(result)}` },
                      ...previous.filter((note) => note.id !== done.id),
                    ]);
                    if (result.status !== 'refused') setOpenId(undefined);
                  }}
                />
              ))}
            </ul>
            {state.data.length === pageSize ? (
              <Button
                variant="secondary"
                className="mt-3 w-full"
                onClick={() => {
                  setPageSize((size) => size + WAITING_PAGE_SIZE);
                }}
              >
                Show more
              </Button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
