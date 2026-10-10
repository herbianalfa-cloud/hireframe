import {
  APPLICATION_LIMITS,
  CvContentSchema,
  CvContentShapeSchema,
  CvDocSchema,
  cvId,
  citedFactIds,
  factAliases,
  isPrintable,
  issueCodes,
  normaliseCvText,
  validateCv,
  type Application,
  type BlockedCode,
  type CvContent,
  type CvFact,
  type CvHeader,
  type CvIssueCode,
  type ExistingFact,
} from '@hireframe/shared';

import type * as Render from '../cv/render/index.js';
import type { LlmCallInput, LlmCallResult } from '../llm/call.js';
import { DailyCapExceededError, LlmOutputError, SpendCapExceededError } from '../llm/errors.js';
import { errorFields, log } from '../log.js';
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
 * most `maxPerRun` applications, starts no model call after `startDeadlineMs`, and never
 * re-enqueues anything. A job's `attempt` is counted in a precondition transaction BEFORE each
 * call and only an owner's move resets it, so a job costs at most `maxAttempts` calls, however
 * many runs are killed.
 */

/** The renderer's surface the worker uses; loaded on first use (`schedule.ts`). */
export type CvRenderer = Pick<
  typeof Render,
  | 'fitOnePage'
  | 'renderCvDocx'
  | 'renderNotePdf'
  | 'renderNoteDocx'
  | 'makeDateOf'
  | 'CvRenderError'
>;

export interface CvWorkerLimits {
  maxPerRun: number;
  readLimit: number;
  startDeadlineMs: number;
  maxAttempts: number;
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

const validatorFacts = (facts: readonly ExistingFact[]): CvFact[] =>
  facts.map((fact) => ({
    id: fact.id,
    type: fact.content.type,
    text: fact.content.text,
    evidence: fact.content.evidence,
    status: fact.status,
  }));

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
      outcome = await generateOne(deps, application);
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

/** An invalid output: one more try while an attempt is left, else blocked with the codes. */
async function invalid(
  deps: CvWorkerDeps,
  counted: Counted,
  issues: readonly CvIssueCode[],
): Promise<JobOutcome> {
  if (counted.attempt >= deps.limits.maxAttempts) {
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
  // the last; on the last attempt the job is blocked rather than left to run again.
  log.error('cv_worker.failed', { attempt: counted.attempt, ...errorFields(error) });
  if (counted.attempt >= deps.limits.maxAttempts) {
    throw new StopRun('error', await block(deps, counted, counted.attempt, 'error'));
  }
  throw new StopRun('error', 'deferred');
}

type Rendered = { ok: true; fit: FitOk; bytes: CvFileBytes } | { ok: false; code: CvIssueCode };
type FitOk = Extract<Awaited<ReturnType<CvRenderer['fitOnePage']>>, { ok: true }>;

/** The one-page fit and the four files; a content that can't be rendered is an issue code. */
async function renderFiles(
  render: CvRenderer,
  header: CvHeader,
  content: CvContent,
  dateOf: ReturnType<CvRenderer['makeDateOf']>,
): Promise<Rendered> {
  try {
    const fit = await render.fitOnePage(header, content, dateOf);
    if (!fit.ok) return { ok: false, code: fit.code };
    const note = await render.renderNotePdf(header, fit.content.coverNote);
    // The 250-word limit makes this hold; `pages` is exact, so it is checked, not assumed.
    if (note.pages !== 1) return { ok: false, code: 'too_long' };
    return {
      ok: true,
      fit,
      bytes: {
        cvPdf: fit.bytes,
        cvDocx: await render.renderCvDocx(header, fit.content, dateOf),
        notePdf: note.bytes,
        noteDocx: await render.renderNoteDocx(header, fit.content.coverNote),
      },
    };
  } catch (error) {
    if (error instanceof render.CvRenderError) return { ok: false, code: error.code };
    throw error;
  }
}

async function generateOne(deps: CvWorkerDeps, application: Application): Promise<JobOutcome> {
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

  // The attempt is counted before the call. A run killed from here on has still used it.
  const counting = await store.commit({
    jobId,
    expect: { stage: 'generating', attempt: application.attempt },
    build: (current) => (current ? planAttempt(current, deps.now()) : null),
    now: deps.now(),
  });
  if (!counting.ok) return 'lost';
  const counted = counting.application;

  const { toAlias, toId } = factAliases(shown.map((fact) => fact.id));
  const version = counted.cvIds.length + 1;
  const id = cvId(jobId, version);

  try {
    const result = await deps.llm({
      purpose: 'cvWrite',
      system: cvSystem(shown, toAlias),
      user: cvUser({
        job,
        notes: counted.notes,
        issues: counted.attempt > 1 ? counted.lastIssues : undefined,
      }),
      schema: CvContentShapeSchema,
      // The worker's own attempt counter is the retry, so no request is made unaccounted.
      maxSends: 1,
    });

    // NFC first: the validator checks printability after NFC, the renderer does not.
    const content = normaliseCvText(result.data);
    // Re-read: a fact archived while the model wrote is caught here, not after publishing.
    const fresh = validatorFacts(await deps.facts());
    const verdict = validateCv(content, toId, fresh);
    if (!verdict.ok) return await invalid(deps, counted, issueCodes(verdict.issues));
    const strict = CvContentSchema.safeParse(content);
    if (!strict.success) return await invalid(deps, counted, ['too_long']);

    const render = await deps.loadRenderer();
    const dateOf = render.makeDateOf(
      toId,
      facts.map((fact) => ({ id: fact.id, dates: fact.content.dates })),
    );
    const rendered = await renderFiles(render, header, strict.data, dateOf);
    if (!rendered.ok) return await invalid(deps, counted, [rendered.code]);
    const { fit } = rendered;
    // Files first: a lost transaction leaves files the next attempt overwrites.
    await deps.files.put(id, rendered.bytes);

    const doc = CvDocSchema.parse({
      jobId,
      applicationVersion: version,
      content: fit.content,
      aliases: Object.fromEntries(toId),
      factIds: citedFactIds(strict.data, toId),
      storagePaths: cvFilePaths(id),
      trimmed: fit.trimmed,
      ...(counted.notes ? { notes: counted.notes } : {}),
      model: result.model,
      costPence: result.costPence,
      createdAt: deps.now(),
      schemaVersion: 1,
    });
    const written = await store.commit({
      jobId,
      expect: { stage: 'generating', attempt: counted.attempt },
      build: (current) => (current ? planReady(current, id, deps.now()) : null),
      cvDoc: { cvId: id, doc },
      now: deps.now(),
    });
    if (!written.ok) {
      // The owner withdrew (or restarted) while the model wrote: take the files back.
      await deps.files.remove(id).catch((error: unknown) => {
        log.warn('cv_worker.failed', { step: 'cleanup', ...errorFields(error) });
      });
      log.info('cv_worker.job', { outcome: 'lost', attempt: counted.attempt });
      return 'lost';
    }
    log.info('cv_worker.job', {
      outcome: 'ready',
      attempt: counted.attempt,
      trimmed: fit.trimmed,
      costPence: result.costPence,
    });
    return 'ready';
  } catch (error) {
    if (error instanceof StopRun) throw error;
    return fail(deps, counted, error);
  }
}
