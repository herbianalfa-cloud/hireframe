import {
  assertNever,
  type Application,
  type ApplicationInput,
  type ApplicationResult,
  type ExistingFact,
} from '@hireframe/shared';

import type { LlmCallInput, LlmCallResult } from '../llm/call.js';
import { log } from '../log.js';
import { planNoteFacts } from '../profile/addFact.js';
import type { ApplicationStore, Change, Expect } from './store.js';
import {
  planAnswer,
  planClearCvs,
  planRegenerate,
  planSkipAll,
  planStart,
  planWithdraw,
  unansweredCount,
  type Known,
} from './transitions.js';

/**
 * The `application` callable's work (M7 7D.1), dependency-injected like `lookup/run.ts`.
 *
 * It moves an application between stages and nothing else: it never writes a CV and never calls
 * the CV model. Its one model call is `answerFact` (an answer turned into facts, through the
 * `addFact` core), and the answer text is the only untrusted text that reaches it; a question's
 * requirement text is shown to the owner and never put in a prompt. Every move is a precondition
 * transaction (store.ts): if the application moved since this call read it, nothing is written.
 */

export type RefusalCode =
  'not_found' | 'wrong_stage' | 'lost' | 'no_fact' | 'header_missing' | 'no_verdict';

/** A request that can't be done from where the application is. User-safe: no job or answer text. */
export class ApplicationRefusal extends Error {
  override name = 'ApplicationRefusal';
  readonly code: RefusalCode;
  constructor(code: RefusalCode) {
    super(`Application refused: ${code}`);
    this.code = code;
  }
}

export interface ApplicationDeps {
  store: ApplicationStore;
  /** The facts already on the profile, for de-duplicating an answer's facts. */
  facts: () => Promise<ExistingFact[]>;
  /** `llmCall` under the monthly cap and the application daily cap, reservation IDs `application-…`. */
  llm: <T>(input: LlmCallInput<T>) => Promise<LlmCallResult<T>>;
  /** Deletes every object under a prefix; returns how many. */
  deleteFiles: (prefix: string) => Promise<number>;
  now: () => Date;
}

const expectOf = (current: Application | null): Expect | null =>
  current ? { stage: current.stage, attempt: current.attempt } : null;

function resultOf(application: Application, factIds?: string[]): ApplicationResult {
  return {
    jobId: application.jobId,
    stage: application.stage,
    ...(application.blocked ? { blocked: application.blocked.code } : {}),
    ...(factIds ? { factIds } : {}),
    unanswered: unansweredCount(application.questions),
  };
}

async function required(deps: ApplicationDeps, jobId: string): Promise<Application> {
  const current = await deps.store.getApplication(jobId);
  if (!current) throw new ApplicationRefusal('not_found');
  return current;
}

async function commit(deps: ApplicationDeps, change: Change) {
  const outcome = await deps.store.commit(change);
  if (!outcome.ok) throw new ApplicationRefusal('lost');
  return outcome;
}

/** The job and header as they are now, for a move that can land on generating. */
async function known(deps: ApplicationDeps, jobId: string): Promise<Known> {
  const job = await deps.store.getJob(jobId);
  if (!job) throw new ApplicationRefusal('not_found');
  const { verdict } = job;
  if (!verdict) throw new ApplicationRefusal('no_verdict');
  return {
    job: { ...job, verdict },
    headerExists: await deps.store.hasCvHeader(),
    now: deps.now(),
  };
}

async function start(
  deps: ApplicationDeps,
  jobId: string,
  mode: 'start' | 'retry',
): Promise<ApplicationResult> {
  const current = await deps.store.getApplication(jobId);
  if (mode === 'retry' && !current) throw new ApplicationRefusal('not_found');
  const info = await known(deps, jobId);
  if (!planStart(jobId, current, info, mode)) throw new ApplicationRefusal('wrong_stage');
  const { application } = await commit(deps, {
    jobId,
    expect: expectOf(current),
    build: (fresh) => planStart(jobId, fresh, info, mode),
    now: info.now,
  });
  return resultOf(application);
}

async function answer(
  deps: ApplicationDeps,
  jobId: string,
  questionId: string,
  text: string,
): Promise<ApplicationResult> {
  const before = await required(deps, jobId);
  const open = before.questions.find((q) => q.id === questionId && q.answer === undefined);
  if (before.stage !== 'needs_input' || !open) throw new ApplicationRefusal('wrong_stage');

  // The only model call: the answer text, in a `<note>` tag it can't close. The requirement
  // text is deliberately not passed.
  const planned = await planNoteFacts({ llm: deps.llm, existing: deps.facts }, 'answerFact', text);
  // An answer becomes a fact only when its evidence is a verbatim quote of the answer: Profile
  // keeps an unverified fact flagged for the owner to check, but a CV claim can't wait for that.
  const plan = {
    fresh: planned.fresh.filter((fact) => fact.evidenceVerified),
    knownIds: planned.verifiedKnownIds,
    costPence: planned.costPence,
  };
  const factCount = plan.fresh.length + plan.knownIds.length;
  log.info('application.answered', {
    added: plan.fresh.length,
    known: plan.knownIds.length,
    dropped: planned.fresh.length - plan.fresh.length,
    costPence: plan.costPence,
  });
  if (factCount === 0) throw new ApplicationRefusal('no_fact');

  const info = await known(deps, jobId);
  const outcome = await commit(deps, {
    jobId,
    expect: expectOf(before),
    facts: plan.fresh,
    build: (fresh, ids) =>
      fresh
        ? planAnswer(
            fresh,
            [questionId],
            { kind: 'fact', factIds: [...ids, ...plan.knownIds] },
            info,
          )
        : null,
    now: info.now,
  });
  return resultOf(outcome.application, [...outcome.factIds, ...plan.knownIds]);
}

/** Skips one question, or every open one. */
async function skip(
  deps: ApplicationDeps,
  jobId: string,
  questionId: string | null,
): Promise<ApplicationResult> {
  const before = await required(deps, jobId);
  const info = await known(deps, jobId);
  const move = (current: Application) =>
    questionId === null
      ? planSkipAll(current, info)
      : planAnswer(current, [questionId], { kind: 'skipped' }, info);
  if (!move(before)) throw new ApplicationRefusal('wrong_stage');
  const { application } = await commit(deps, {
    jobId,
    expect: expectOf(before),
    build: (fresh) => (fresh ? move(fresh) : null),
    now: info.now,
  });
  return resultOf(application);
}

async function regenerate(
  deps: ApplicationDeps,
  jobId: string,
  notes: string | undefined,
): Promise<ApplicationResult> {
  const before = await required(deps, jobId);
  if (before.stage !== 'ready') throw new ApplicationRefusal('wrong_stage');
  // A new CV can't be written without the header; the ready one is left as it is.
  if (!(await deps.store.hasCvHeader())) throw new ApplicationRefusal('header_missing');
  const now = deps.now();
  const { application } = await commit(deps, {
    jobId,
    expect: expectOf(before),
    build: (fresh) => (fresh ? planRegenerate(fresh, notes, now) : null),
    now,
  });
  return resultOf(application);
}

/** Deletes a withdrawn application's files and `cvs` docs, then forgets them. */
async function deleteCvs(deps: ApplicationDeps, jobId: string): Promise<Application> {
  const current = await required(deps, jobId);
  if (current.stage !== 'withdrawn') return current;
  for (const cvId of current.cvIds) await deps.deleteFiles(`cvs/${cvId}/`);
  await deps.store.deleteCvDocs(current.cvIds);
  const now = deps.now();
  const { application } = await commit(deps, {
    jobId,
    expect: expectOf(current),
    build: (fresh) => (fresh ? planClearCvs(fresh, now) : null),
    now,
  });
  return application;
}

async function withdraw(
  deps: ApplicationDeps,
  jobId: string,
  deleteFiles: boolean,
): Promise<ApplicationResult> {
  const before = await required(deps, jobId);
  // Withdrawn already: only the clean-up of an earlier "keep files" withdraw is left to do.
  if (before.stage === 'withdrawn') {
    if (!deleteFiles || before.cvIds.length === 0) throw new ApplicationRefusal('wrong_stage');
    return resultOf(await deleteCvs(deps, jobId));
  }
  const now = deps.now();
  if (!planWithdraw(before, now)) throw new ApplicationRefusal('wrong_stage');
  const { application } = await commit(deps, {
    jobId,
    expect: expectOf(before),
    build: (fresh) => (fresh ? planWithdraw(fresh, now) : null),
    now,
  });
  log.info('application.withdrawn', { deleteFiles, cvs: application.cvIds.length });
  // The stage moved first, so the worker can write nothing more for it while the files go.
  return resultOf(deleteFiles ? await deleteCvs(deps, jobId) : application);
}

export async function runApplication(
  deps: ApplicationDeps,
  input: ApplicationInput,
): Promise<ApplicationResult> {
  switch (input.action) {
    case 'start':
      return start(deps, input.jobId, 'start');
    case 'retry':
      return start(deps, input.jobId, 'retry');
    case 'answer':
      return answer(deps, input.jobId, input.questionId, input.text);
    case 'skip':
      return skip(deps, input.jobId, input.questionId);
    case 'skipAll':
      return skip(deps, input.jobId, null);
    case 'regenerate':
      return regenerate(deps, input.jobId, input.notes);
    case 'withdraw':
      return withdraw(deps, input.jobId, input.deleteFiles);
    default:
      return assertNever(input);
  }
}
