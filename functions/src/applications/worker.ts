import {
  APPLICATION_LIMITS,
  CvContentShapeSchema,
  CvDocSchema,
  cvId,
  factAliases,
  isPrintable,
  type Application,
  type BlockedCode,
  type CvHeader,
  type CvIssueCode,
  type ExistingFact,
} from '@hireframe/shared';

import type * as Render from '../cv/render/index.js';
import type { LlmCallInput, LlmCallResult } from '../llm/call.js';
import { DailyCapExceededError, LlmOutputError, SpendCapExceededError } from '../llm/errors.js';
import { errorFields, log } from '../log.js';
import { composeCv, type ComposeResult } from './compose.js';
import { cvFilePaths, type CvFileBytes, type CvFileStore } from './files.js';
import { cvSystem, cvUser, type PromptFact } from './prompt.js';
import type { ApplicationStore } from './store.js';
import { planAttempt, planBlocked, planReady, planRetry } from './transitions.js';

/**
 * The CV worker's core (M7 7D.2, ADR-053): one pass over the applications at `generating`.
 * Pure of Firebase: the store, the model, the files, the renderer and the clock are injected, so
 * every outcome is testable on a fake clock. `schedule.ts` wires the real ones.
 *
 * Bounds (CLAUDE.md "No self-triggering code"): it runs only when the schedule starts it, takes at
 * most `maxPerRun` applications, starts no model call after `startDeadlineMs` (the revision
 * included), and never re-enqueues anything. A job's `attempt` is counted in a precondition
 * transaction BEFORE each call, the revision's too, and only an owner's move resets it, so a job
 * costs at most `maxAttempts` calls, however many runs are killed.
 */

/** The renderer's surface the worker uses; loaded on first use (`schedule.ts`). */
export type CvRenderer = Pick<
  typeof Render,
  | 'fitPage'
  | 'renderCvDocx'
  | 'renderNotePdf'
  | 'renderNoteDocx'
  | 'makeDateOf'
  | 'makeEndKeyOf'
  | 'makeHasEndOf'
  | 'CvRenderError'
>;

export interface CvWorkerLimits {
  maxPerRun: number;
  readLimit: number;
  startDeadlineMs: number;
  /** Writes one job may cost (the first and one retry): `invalid` blocks at this count. */
  maxWrites: number;
  /** Model calls one job may cost, the revision included. */
  maxAttempts: number;
  /** A CV at or above this total, with no hard finding, is not revised. */
  scoreTarget: number;
}

export interface CvWorkerDeps {
  store: ApplicationStore;
  /** Every fact, archived ones included. */
  facts(): Promise<ExistingFact[]>;
  /** `llmCall` over the application deps: monthly cap, daily cap, `application-` reservations. */
  llm<T>(input: LlmCallInput<T>): Promise<LlmCallResult<T>>;
  files: CvFileStore;
  loadRenderer(): Promise<CvRenderer>;
  now(): Date;
  limits: CvWorkerLimits;
}

export type JobOutcome = 'ready' | 'retry' | 'blocked' | 'deferred' | 'lost' | 'untouched';

export interface WorkerSummary {
  read: number;
  ready: number;
  retried: number;
  blocked: number;
  /** Left at generating after a failure that wasn't about the job's output. */
  deferred: number;
  /** A precondition no longer held (the owner moved the job); nothing was written. */
  lost: number;
  /** Not started: the deadline or the run's stop came first. */
  untouched: number;
  stoppedBy: 'deadline' | 'cap' | 'error' | null;
}

type Counted = Application;

/** Ends the run after the job that raised it was moved or left; `outcome` is that job's. */
class StopRun extends Error {
  readonly reason: 'cap' | 'error';
  readonly outcome: JobOutcome;

  constructor(reason: 'cap' | 'error', outcome: JobOutcome) {
    super(reason);
    this.reason = reason;
    this.outcome = outcome;
  }
}

/** Every string in the header must print in the CV's font; one that can't is as good as none. */
function headerPrintable(header: CvHeader): boolean {
  const strings = [
    header.name,
    header.email,
    header.phone,
    header.location,
    ...(header.links ?? []),
  ];
  return strings.every((value) => value === undefined || isPrintable(value));
}

function promptFacts(facts: readonly ExistingFact[]): PromptFact[] {
  return facts
    .filter((fact) => fact.status === 'active' && fact.content.type !== 'preference')
    .map((fact) => ({
      id: fact.id,
      type: fact.content.type,
      text: fact.content.text,
      dates: fact.content.dates,
    }));
}

export async function runCvWorker(deps: CvWorkerDeps): Promise<WorkerSummary> {
  const { limits } = deps;
  const startedAt = deps.now().getTime();
  const summary: WorkerSummary = {
    read: 0,
    ready: 0,
    retried: 0,
    blocked: 0,
    deferred: 0,
    lost: 0,
    untouched: 0,
    stoppedBy: null,
  };
  const queue = await deps.store.listGenerating(limits.maxPerRun, limits.readLimit);
  summary.read = queue.length;
  log.info('cv_worker.started', { pending: queue.length });

  for (const [index, application] of queue.entries()) {
    if (deps.now().getTime() - startedAt >= limits.startDeadlineMs) {
      summary.stoppedBy = 'deadline';
      summary.untouched = queue.length - index;
      break;
    }
    let outcome: JobOutcome;
    try {
      outcome = await generateOne(deps, application, startedAt);
    } catch (error) {
      if (!(error instanceof StopRun)) throw error;
      summary.stoppedBy = error.reason;
      summary.untouched = queue.length - index - 1;
      ({ outcome } = error);
    }
    tally(summary, outcome);
    if (summary.stoppedBy) break;
  }
  log.info('cv_worker.done', { ...summary, stoppedBy: summary.stoppedBy ?? 'none' });
  return summary;
}

function tally(summary: WorkerSummary, outcome: JobOutcome): void {
  if (outcome === 'ready') summary.ready += 1;
  else if (outcome === 'retry') summary.retried += 1;
  else if (outcome === 'blocked') summary.blocked += 1;
  else if (outcome === 'deferred') summary.deferred += 1;
  else if (outcome === 'lost') summary.lost += 1;
}

/** Moves `application` (still at `expectAttempt`) with `plan`; false when the owner moved it. */
async function move(
  deps: CvWorkerDeps,
  application: Application,
  attempt: number,
  plan: (current: Application) => Application | null,
): Promise<boolean> {
  const result = await deps.store.commit({
    jobId: application.jobId,
    expect: { stage: 'generating', attempt },
    build: (current) => (current ? plan(current) : null),
    now: deps.now(),
  });
  return result.ok;
}

async function block(
  deps: CvWorkerDeps,
  application: Application,
  attempt: number,
  code: BlockedCode,
  issues: readonly CvIssueCode[] = [],
): Promise<JobOutcome> {
  const moved = await move(deps, application, attempt, (current) =>
    planBlocked(current, code, deps.now(), issues),
  );
  log.info('cv_worker.job', { outcome: moved ? 'blocked' : 'lost', code, attempt });
  return moved ? 'blocked' : 'lost';
}

/** An invalid output: one more try while a write is left, else blocked with the codes. */
async function invalid(
  deps: CvWorkerDeps,
  counted: Counted,
  issues: readonly CvIssueCode[],
): Promise<JobOutcome> {
  if (counted.attempt >= deps.limits.maxWrites) {
    return block(deps, counted, counted.attempt, 'invalid_output', issues);
  }
  const moved = await move(deps, counted, counted.attempt, (current) =>
    planRetry(current, issues, deps.now()),
  );
  log.info('cv_worker.job', {
    outcome: moved ? 'retry' : 'lost',
    attempt: counted.attempt,
    issues: issues.join(','),
  });
  return moved ? 'retry' : 'lost';
}

/** Failures that aren't about the job's output. Throws `StopRun` for the ones that end the run. */
async function fail(deps: CvWorkerDeps, counted: Counted, error: unknown): Promise<JobOutcome> {
  if (error instanceof DailyCapExceededError) {
    throw new StopRun('cap', await block(deps, counted, counted.attempt, 'daily_cap'));
  }
  if (error instanceof SpendCapExceededError) {
    throw new StopRun('cap', await block(deps, counted, counted.attempt, 'cap'));
  }
  if (error instanceof LlmOutputError) {
    // A refusal or a cut-off answer won't change on a second try with the same prompt.
    if (error.failure === 'refusal' || error.failure === 'max_tokens') {
      return block(deps, counted, counted.attempt, 'invalid_output');
    }
    return invalid(deps, counted, []);
  }
  // An API, storage or render failure. The attempt is already counted, so the next run's call is
  // the last write; once the writes are spent the job is blocked rather than left to run again.
  log.error('cv_worker.failed', { attempt: counted.attempt, ...errorFields(error) });
  if (counted.attempt >= deps.limits.maxWrites) {
    throw new StopRun('error', await block(deps, counted, counted.attempt, 'error'));
  }
  throw new StopRun('error', 'deferred');
}

type FitOk = Extract<Awaited<ReturnType<CvRenderer['fitPage']>>, { ok: true }>;

/** The four files of a fitted CV; a cover note that doesn't fit one page is an issue code. */
async function renderFiles(
  render: CvRenderer,
  header: CvHeader,
  fit: FitOk,
  dateOf: ReturnType<CvRenderer['makeDateOf']>,
): Promise<CvFileBytes | CvIssueCode> {
  try {
    const note = await render.renderNotePdf(header, fit.content.coverNote);
    // The 250-word limit makes this hold; `pages` is exact, so it is checked, not assumed.
    if (note.pages !== 1) return 'too_long';
    return {
      cvPdf: fit.bytes,
      cvDocx: await render.renderCvDocx(header, fit.content, dateOf, fit.spec),
      notePdf: note.bytes,
      noteDocx: await render.renderNoteDocx(header, fit.content.coverNote),
    };
  } catch (error) {
    if (error instanceof render.CvRenderError) return error.code;
    throw error;
  }
}

async function generateOne(
  deps: CvWorkerDeps,
  application: Application,
  startedAt: number,
): Promise<JobOutcome> {
  const { jobId } = application;
  const { store, limits } = deps;

  // Nothing here costs an attempt: a job that can't be written is blocked before any count.
  if (application.attempt >= limits.maxAttempts) {
    return block(deps, application, application.attempt, 'attempts_exhausted');
  }
  const header = await store.getCvHeader();
  if (!header || !headerPrintable(header)) {
    return block(deps, application, application.attempt, 'cv_header_missing');
  }
  const job = await store.getJobForCv(jobId);
  if (!job) return block(deps, application, application.attempt, 'no_deep_read');
  if (application.cvIds.length >= APPLICATION_LIMITS.cvIds) {
    return block(deps, application, application.attempt, 'error');
  }
  const facts = await deps.facts();
  const shown = promptFacts(facts);
  if (shown.length === 0) return block(deps, application, application.attempt, 'error');

  // Every model call is counted before it is made (the write here, the revision in `compose`).
  // A run killed from here on has still used it.
  const countNext = async (from: Counted): Promise<Counted | null> => {
    const counting = await store.commit({
      jobId,
      expect: { stage: 'generating', attempt: from.attempt },
      build: (current) => (current ? planAttempt(current, deps.now()) : null),
      now: deps.now(),
    });
    return counting.ok ? counting.application : null;
  };
  let counted = await countNext(application);
  if (!counted) return 'lost';

  const { toAlias, toId } = factAliases(shown.map((fact) => fact.id));
  const version = counted.cvIds.length + 1;
  const id = cvId(jobId, version);
  const system = cvSystem(shown, toAlias);
  // Which step the files are at: an upload that failed part-way, or a commit that threw, leaves
  // files nothing records. `none` has written nothing; `unrecorded` is safe to delete outright;
  // `committing` may have committed, so it is checked before anything is removed.
  let files: 'none' | 'unrecorded' | 'committing' = 'none';

  try {
    const written = await deps.llm({
      purpose: 'cvWrite',
      system,
      user: cvUser({
        job,
        notes: counted.notes,
        issues: counted.attempt > 1 ? counted.lastIssues : undefined,
        toAlias,
      }),
      schema: CvContentShapeSchema,
      // The worker's own attempt counter is the retry, so no request is made unaccounted.
      maxSends: 1,
    });

    const render = await deps.loadRenderer();
    const composed: ComposeResult = await composeCv(
      {
        render,
        // Re-read: a fact archived while the model wrote is caught here, not after publishing.
        facts: () => deps.facts(),
        countAttempt: async () => {
          const next = await countNext(counted ?? application);
          if (next) counted = next;
          return next !== null;
        },
        revise: (user) =>
          deps.llm({
            purpose: 'cvRevise',
            system,
            user,
            schema: CvContentShapeSchema,
            maxSends: 1,
          }),
        beforeDeadline: () => deps.now().getTime() - startedAt < limits.startDeadlineMs,
      },
      {
        draft: written.data,
        header,
        job,
        notes: counted.notes,
        facts: await deps.facts(),
        toAlias,
        toId,
        attempt: counted.attempt,
        maxAttempts: limits.maxAttempts,
        scoreTarget: limits.scoreTarget,
        writeCostPence: written.costPence,
      },
    );
    if (composed.kind === 'lost') return 'lost';
    if (composed.kind === 'invalid') return await invalid(deps, counted, composed.issues);
    const { shipped } = composed;
    const { fit } = shipped;

    const dateOf = render.makeDateOf(
      toId,
      shipped.facts.map((fact) => ({ id: fact.id, dates: fact.content.dates })),
    );
    const bytes = await renderFiles(render, header, fit, dateOf);
    if (typeof bytes === 'string') return await invalid(deps, counted, [bytes]);
    // Files first: a lost transaction leaves files the next attempt overwrites.
    files = 'unrecorded';
    await deps.files.put(id, bytes);

    const doc = CvDocSchema.parse({
      jobId,
      applicationVersion: version,
      content: fit.content,
      aliases: Object.fromEntries(toId),
      factIds: shipped.factIds,
      storagePaths: cvFilePaths(id),
      trimmed: fit.trimmed,
      quality: shipped.quality,
      ...(counted.notes ? { notes: counted.notes } : {}),
      model: written.model,
      costPence: shipped.costPence,
      createdAt: deps.now(),
      schemaVersion: 1,
    });
    const expectAttempt = counted.attempt;
    files = 'committing';
    const committed = await store.commit({
      jobId,
      expect: { stage: 'generating', attempt: expectAttempt },
      build: (current) => (current ? planReady(current, id, deps.now()) : null),
      cvDoc: { cvId: id, doc },
      now: deps.now(),
    });
    if (!committed.ok) {
      // The owner withdrew (or restarted) while the model wrote: take the files back. A
      // transaction that reran after its first attempt landed also reports lost, and then the
      // document lists this version: removeIfUnrecorded keeps those files.
      await removeIfUnrecorded(deps, jobId, id);
      log.info('cv_worker.job', { outcome: 'lost', attempt: expectAttempt });
      return 'lost';
    }
    log.info('cv_worker.job', {
      outcome: 'ready',
      attempt: expectAttempt,
      trimmed: fit.trimmed,
      costPence: shipped.costPence,
      total: shipped.quality.total,
      revised: shipped.quality.revised,
      ...(shipped.quality.revisionSkipped
        ? { revisionSkipped: shipped.quality.revisionSkipped }
        : {}),
    });
    // A revision refused by a cap, or failed by the API, shipped its draft; the run ends after it.
    if (composed.stop) throw new StopRun(composed.stop, 'ready');
    return 'ready';
  } catch (error) {
    if (error instanceof StopRun) throw error;
    if (files === 'unrecorded') await removeFiles(deps, id);
    if (files === 'committing') await removeIfUnrecorded(deps, jobId, id);
    return fail(deps, counted, error);
  }
}

/** Best-effort delete of a CV's files; a failure is logged with codes only, never CV text. */
async function removeFiles(deps: CvWorkerDeps, id: string): Promise<void> {
  try {
    await deps.files.remove(id);
  } catch (error) {
    log.warn('cv_worker.failed', { step: 'cleanup', ...errorFields(error) });
  }
}

/**
 * After a ready commit that threw: the write may have landed before the error did, and files the
 * document points at must stay. Remove them only when the application doesn't list this version;
 * if that can't be read, leave them (an orphan is overwritten by the next attempt).
 */
async function removeIfUnrecorded(deps: CvWorkerDeps, jobId: string, id: string): Promise<void> {
  try {
    const current = await deps.store.getApplication(jobId);
    if (current?.cvIds.includes(id)) return;
  } catch (error) {
    log.warn('cv_worker.failed', { step: 'cleanup_check', ...errorFields(error) });
    return;
  }
  await removeFiles(deps, id);
}
