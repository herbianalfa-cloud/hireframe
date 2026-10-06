import type { Job } from '@hireframe/shared';
import {
  Bookmark,
  CircleCheck,
  CircleMinus,
  CircleX,
  ExternalLink,
  FileText,
  ThumbsDown,
  ThumbsUp,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/format';
import { useFacts } from '@/features/profile/hooks';
import type { JobView } from '@/services/jobs';

import { performJobAction, type JobAction, type JobActionHandlers } from './actions';
import { SourceAttribution } from './AdzunaAttribution';
import { FeedbackDialog } from './FeedbackDialog';
import { useJob, useJobDescription } from './hooks';
import {
  FLAG_TEXT,
  GAP_LABELS,
  LEVEL_LABELS,
  MATCH_LABELS,
  isSearchLink,
  linkHost,
  postedText,
  REVIEW_TEXT,
  salaryText,
  scoreText,
  skipText,
  SOURCE_NAMES,
  STAGE_NAMES,
  STATUS_LABELS,
  VERDICT_LABELS,
} from './labels';
import { VerdictBadge } from './VerdictBadge';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="mt-2 text-sm">{children}</div>
    </section>
  );
}

const MATCH_ICONS = { met: CircleCheck, partial: CircleMinus, missing: CircleX } as const;

function Requirements({ job, factText }: { job: Job; factText: (factId: string) => string }) {
  const requirements = job.deep?.requirements ?? [];
  if (requirements.length === 0) return null;
  return (
    <Section title="Requirements">
      <ul className="divide-y rounded-md border">
        {requirements.map((requirement, index) => {
          const Icon = MATCH_ICONS[requirement.match];
          return (
            <li key={index} className="px-3 py-2">
              <p className="flex items-start gap-2">
                <Icon
                  aria-hidden="true"
                  className={`mt-0.5 size-4 shrink-0 ${
                    requirement.match === 'met'
                      ? 'text-verdict-apply'
                      : requirement.match === 'partial'
                        ? 'text-verdict-near-miss'
                        : 'text-danger'
                  }`}
                />
                <span className="flex-1">
                  <span className="text-xs font-medium">{MATCH_LABELS[requirement.match]}</span>
                  <span className="text-xs text-muted-foreground">
                    {' · '}
                    {LEVEL_LABELS[requirement.level]}
                    {requirement.gap ? ` · gap: ${GAP_LABELS[requirement.gap]}` : ''}
                  </span>
                  <br />
                  {requirement.text}
                </span>
              </p>
              {requirement.factIds.length > 0 ? (
                <ul className="mt-1 ml-6 space-y-0.5 text-xs text-muted-foreground">
                  {requirement.factIds.map((factId) => (
                    <li key={factId}>Evidence: {factText(factId)}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Description({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Description">
      {open ? (
        <DescriptionText jobId={jobId} />
      ) : (
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(true);
          }}
        >
          <FileText aria-hidden="true" />
          Show description
        </Button>
      )}
    </Section>
  );
}

/** The stored text, shown as plain text only: it comes from the open web, so it is never parsed. */
function DescriptionText({ jobId }: { jobId: string }) {
  const state = useJobDescription(jobId);
  if (state.status === 'loading')
    return <Skeleton role="status" aria-label="Loading description" className="h-24" />;
  if (state.status === 'error') {
    return (
      <p role="alert" className="text-danger">
        Couldn&apos;t load the description.
      </p>
    );
  }
  if (!state.description) return <p className="text-muted-foreground">No description stored.</p>;
  return (
    <>
      {state.description.kind === 'snippet' ? (
        <p className="mb-2 text-xs text-muted-foreground">
          Only a short snippet is available for this job.
        </p>
      ) : null}
      <pre className="max-h-96 overflow-y-auto rounded-md border bg-background p-3 font-sans text-sm whitespace-pre-wrap break-words">
        {state.description.text}
      </pre>
    </>
  );
}

/** One button for a state and its undo: same place and icon, selected while the state holds. */
function StatusToggle({
  icon: Icon,
  on,
  onLabel,
  offLabel,
  disabled,
  onPress,
  tone = 'accent',
}: {
  /** `apply` is the green Apply colour: solid when off, hollow when on. */
  tone?: 'accent' | 'apply';
  icon: LucideIcon;
  on: boolean;
  onLabel: string;
  offLabel: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      variant={tone === 'apply' ? (on ? 'applyOutline' : 'apply') : on ? 'default' : 'secondary'}
      aria-pressed={on}
      disabled={disabled}
      onClick={onPress}
    >
      <Icon aria-hidden="true" />
      {on ? onLabel : offLabel}
    </Button>
  );
}

function Actions({
  view,
  handlers,
  onRateDown,
}: {
  view: JobView;
  handlers: JobActionHandlers;
  onRateDown: () => void;
}) {
  const { job } = view;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const serverOwned = !['new', 'saved', 'applied', 'skipped'].includes(job.status);

  async function run(action: JobAction) {
    setPending(true);
    setError(undefined);
    const result = await performJobAction(view, action, handlers);
    if (!result.ok && 'message' in result) setError(result.message);
    setPending(false);
  }

  const to = (status: 'new' | 'saved' | 'applied' | 'skipped') => () =>
    run({ kind: 'status', to: status });

  return (
    <div className="mt-6 border-t pt-4">
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="secondary">
          <a href={job.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden="true" />
            {isSearchLink(job.url) ? 'Search link' : 'Open posting'}
          </a>
        </Button>
        <StatusToggle
          icon={CircleCheck}
          on={job.status === 'applied'}
          tone="apply"
          onLabel="Applied"
          offLabel="Apply"
          disabled={pending || serverOwned}
          onPress={() => void to(job.status === 'applied' ? 'new' : 'applied')()}
        />
        <StatusToggle
          icon={Bookmark}
          on={job.status === 'saved'}
          onLabel="Unsave"
          offLabel="Save"
          disabled={pending || serverOwned || !['new', 'saved'].includes(job.status)}
          onPress={() => void to(job.status === 'saved' ? 'new' : 'saved')()}
        />
        <StatusToggle
          icon={CircleMinus}
          on={job.status === 'skipped'}
          onLabel="Unskip"
          offLabel="Skip"
          // Skipping an applied job would clear its applied stamps.
          disabled={pending || serverOwned || job.status === 'applied'}
          onPress={() => void to(job.status === 'skipped' ? 'new' : 'skipped')()}
        />
      </div>
      {job.verdict ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Was this verdict right?</span>
          <Button
            variant={job.feedback?.agree === true ? 'default' : 'secondary'}
            size="icon"
            aria-label="Verdict was right"
            aria-pressed={job.feedback?.agree === true}
            disabled={pending}
            onClick={() => {
              // Pressing the selected 👍 again takes the rating back.
              void run(
                job.feedback?.agree === true
                  ? { kind: 'unrate' }
                  : { kind: 'rate', input: { agree: true } },
              );
            }}
          >
            <ThumbsUp aria-hidden="true" />
          </Button>
          <Button
            variant={job.feedback?.agree === false ? 'default' : 'secondary'}
            size="icon"
            aria-label="Verdict was wrong"
            aria-pressed={job.feedback?.agree === false}
            disabled={pending}
            onClick={() => {
              if (job.feedback?.agree === false) void run({ kind: 'unrate' });
              else onRateDown();
            }}
          >
            <ThumbsDown aria-hidden="true" />
          </Button>
          {job.feedback ? (
            <span className="text-xs text-muted-foreground">
              You rated it {job.feedback.agree ? 'right' : 'wrong'} on {formatDate(job.feedback.at)}
              {job.feedback.verdict !== job.verdict
                ? ` (it was ${VERDICT_LABELS[job.feedback.verdict]} then)`
                : ''}
              {job.feedback.expected
                ? `, should have been ${VERDICT_LABELS[job.feedback.expected]}`
                : ''}
              {job.feedback.note ? `: ${job.feedback.note}` : ''}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3">
        <Button variant="secondary" disabled title="Arrives with CV tailoring (M7)">
          Generate CV
        </Button>
        <span className="ml-2 text-xs text-muted-foreground">Arrives with CV tailoring (M7)</span>
      </div>
      <div aria-live="polite">
        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function JobBody({ view, handlers }: { view: JobView; handlers: JobActionHandlers }) {
  const { job } = view;
  const facts = useFacts();
  const [rating, setRating] = useState(false);
  const now = new Date();
  const factById = new Map(
    facts.status === 'ready' ? facts.data.map((item) => [item.id, item.fact.text]) : [],
  );
  const factText = (factId: string) =>
    factById.get(factId) ?? (facts.status === 'ready' ? 'a fact no longer in your profile' : '…');
  const salary = salaryText(job);

  return (
    <>
      <DialogTitle>{job.title}</DialogTitle>
      <DialogDescription>
        {job.company} · {job.location || 'Location not stated'}
        {job.remote !== 'unknown' ? ` · ${job.remote}` : ''}
        {salary ? ` · ${salary}` : ''} · {postedText(job, now)}
      </DialogDescription>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {job.verdict ? <VerdictBadge verdict={job.verdict} /> : <Badge>Not judged yet</Badge>}
        <Badge>{STATUS_LABELS[job.status]}</Badge>
        {job.fitScore !== undefined ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            fit {scoreText(job.fitScore)} · luck {scoreText(job.luckScore)}
          </span>
        ) : null}
      </div>

      {job.reason ? <p className="mt-4 text-sm">{job.reason}</p> : null}
      {job.verdict === 'near_miss' && job.shortfall ? (
        <Section title="What fell short">
          <p>{job.shortfall}</p>
        </Section>
      ) : null}
      {job.skip ? (
        <Section title="Why it was skipped">
          <p>{skipText(job.skip)}</p>
        </Section>
      ) : null}
      {job.review ? (
        <Section title="Waiting for you">
          <p>
            The {STAGE_NAMES[job.review.stage]} step couldn&apos;t judge this job:{' '}
            {REVIEW_TEXT[job.review.code]}. Read it yourself; a re-score may retry it.
          </p>
        </Section>
      ) : job.next === 'description' ? (
        <Section title="Needs a description">
          <p>
            This job came from an email alert, which carries no description, so there is nothing to
            read yet. A later scan may find the posting on the company&apos;s job board.
          </p>
        </Section>
      ) : job.next ? (
        <Section title="Queued">
          <p>Waiting for the {STAGE_NAMES[job.next]} step in a later run.</p>
        </Section>
      ) : null}
      {job.flags && job.flags.length > 0 ? (
        <Section title="Flags">
          <ul className="list-disc space-y-0.5 pl-5">
            {job.flags.map((flag) => (
              <li key={flag}>{FLAG_TEXT[flag]}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Requirements job={job} factText={factText} />

      {job.matchedFactIds && job.matchedFactIds.length > 0 ? (
        <Section title="Matched facts">
          <ul className="list-disc space-y-0.5 pl-5">
            {job.matchedFactIds.map((factId) => (
              <li key={factId}>{factText(factId)}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      {job.gaps && job.gaps.length > 0 ? (
        <Section title="Gaps">
          <ul className="list-disc space-y-0.5 pl-5">
            {job.gaps.map((gap, index) => (
              <li key={index}>
                <span className="text-xs text-muted-foreground">{GAP_LABELS[gap.type]}: </span>
                {gap.text}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {job.talkingPoints && job.talkingPoints.length > 0 ? (
        <Section title="Talking points">
          <ul className="list-disc space-y-0.5 pl-5">
            {job.talkingPoints.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Description jobId={view.id} />

      <Section title="Sources">
        <ul className="space-y-1">
          {job.sources.map((source) => (
            <li key={`${source.id}:${source.externalId}`}>
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4"
              >
                {SOURCE_NAMES[source.id] ?? source.id}
              </a>
              <span className="text-xs text-muted-foreground">
                {source.searchLink && !source.unverified ? ' · search link' : ''}
                {source.unverified ? ` · unverified link (${linkHost(source.url)})` : ''} · seen{' '}
                {formatDate(source.seenAt)}
              </span>
              {source.easyApply ? (
                <Badge variant="accent" className="ml-2">
                  Easy Apply on LinkedIn
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
        <SourceAttribution job={job} />
      </Section>

      <Actions
        view={view}
        handlers={handlers}
        onRateDown={() => {
          setRating(true);
        }}
      />
      {rating ? (
        <FeedbackDialog
          view={view}
          onClose={() => {
            setRating(false);
          }}
          handlers={handlers}
        />
      ) : null}
    </>
  );
}

/**
 * Job detail (PRD R7, R6): a right-hand sheet on desktop, full screen on phones. Everything
 * from the job is shown as plain text; a posting can say anything, so none of it is parsed.
 */
export function JobDetail({
  jobId,
  onClose,
  onPatch,
  onCommitted,
}: {
  jobId: string;
  onClose: () => void;
} & JobActionHandlers) {
  const state = useJob(jobId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent side="right" className="md:max-w-xl">
        {state.status === 'loading' ? (
          <div role="status" aria-label="Loading job" className="space-y-3">
            <DialogTitle>Job</DialogTitle>
            <DialogDescription className="sr-only">Loading</DialogDescription>
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-32" />
          </div>
        ) : state.status === 'error' ? (
          <>
            <DialogTitle>Job</DialogTitle>
            <DialogDescription className="sr-only">Couldn&apos;t load</DialogDescription>
            <p role="alert" className="mt-3 text-sm text-danger">
              {state.message}
            </p>
          </>
        ) : state.data === null ? (
          <>
            <DialogTitle>Job not found</DialogTitle>
            <DialogDescription className="sr-only">Missing</DialogDescription>
            <p className="mt-3 text-sm text-muted-foreground">
              This job no longer exists. Close this and pick another.
            </p>
          </>
        ) : (
          <JobBody view={state.data} handlers={{ onPatch, onCommitted }} />
        )}
      </DialogContent>
    </Dialog>
  );
}
