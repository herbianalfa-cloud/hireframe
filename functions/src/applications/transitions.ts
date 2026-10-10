import {
  APPLICATION_LIMITS,
  questionsFromRequirements,
  type Application,
  type ApplicationStage,
  type BlockedCode,
  type CvIssueCode,
  type JobDeep,
  type Question,
  type Verdict,
} from '@hireframe/shared';

/**
 * The application stage machine (M7 plan, "Stage machine"), as pure functions: each takes the
 * application as it is and what the call knows, and returns the document that should replace it,
 * or null when the move isn't allowed from where the application is. No I/O, so every row of the
 * stage table is testable without a store. `run.ts` supplies the facts and commits the result.
 */

/** What a start needs from the job. */
export interface JobForApplication {
  title: string;
  company: string;
  verdict?: Verdict;
  deep?: Pick<JobDeep, 'requirements'>;
}

export interface Known {
  job: JobForApplication & { verdict: Verdict };
  /** `profile/cvHeader` exists. */
  headerExists: boolean;
  now: Date;
}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

function snapshot(job: Known['job']): Application['job'] {
  return {
    title: clip(job.title, 200),
    company: clip(job.company, 200),
    verdict: job.verdict,
  };
}

/** Questions with neither an answer nor a skip. */
export const unansweredCount = (questions: readonly Question[]): number =>
  questions.filter((question) => question.answer === undefined).length;

/**
 * Questions for a (re)start: the job's current ones, each keeping an answer it already had, then
 * any answered question that is no longer asked, so an answer is never thrown away by a re-score.
 */
export function mergeQuestions(
  existing: readonly Question[],
  deep: JobForApplication['deep'],
): Question[] {
  const fresh = deep ? questionsFromRequirements(deep, APPLICATION_LIMITS.maxQuestions) : [];
  const byId = new Map(existing.map((question) => [question.id, question]));
  const merged = fresh.map((question) => {
    const before = byId.get(question.id);
    return before?.answer ? { ...question, answer: before.answer } : question;
  });
  const kept = new Set(merged.map((question) => question.id));
  for (const question of existing) {
    if (merged.length >= APPLICATION_LIMITS.maxQuestions) break;
    if (question.answer && !kept.has(question.id)) merged.push(question);
  }
  return merged;
}

/** What a move keeps from the application it replaces. */
interface Carry {
  notes?: string | undefined;
  startedAt?: Date | undefined;
  cvIds?: string[] | undefined;
  currentCvId?: string | undefined;
}

/** A fresh document with the fields every move shares; callers add what differs. */
function withStage(
  current: Application | null,
  base: Pick<Application, 'jobId' | 'job'>,
  stage: ApplicationStage,
  now: Date,
  rest: { questions: Question[]; blocked?: BlockedCode } & Carry,
): Application {
  return {
    jobId: base.jobId,
    job: base.job,
    stage,
    stageAt: current?.stage === stage ? current.stageAt : now,
    startedAt: rest.startedAt ?? current?.startedAt ?? now,
    updatedAt: now,
    ...(rest.blocked ? { blocked: { code: rest.blocked, at: now } } : {}),
    questions: rest.questions,
    attempt: 0,
    ...(rest.notes ? { notes: rest.notes } : {}),
    cvIds: rest.cvIds ?? current?.cvIds ?? [],
    ...(rest.currentCvId ? { currentCvId: rest.currentCvId } : {}),
    schemaVersion: 1,
  };
}

/**
 * Where an application goes once its questions are settled or it (re)starts: needs_input while
 * a question is open, chosen with a reason when it can't be written, else generating.
 */
function settle(
  jobId: string,
  current: Application | null,
  known: Known,
  questions: Question[],
  carry: Carry,
): Application {
  const base = { jobId, job: snapshot(known.job) };
  const blockedAs = (code: BlockedCode) =>
    withStage(current, base, 'chosen', known.now, { questions, blocked: code, ...carry });
  if (!known.job.deep) return blockedAs('no_deep_read');
  if (!known.headerExists) return blockedAs('cv_header_missing');
  const stage = unansweredCount(questions) > 0 ? 'needs_input' : 'generating';
  return withStage(current, base, stage, known.now, { questions, ...carry });
}

/** `start` from nothing or withdrawn; `retry` from chosen. Anything else is refused. */
export function planStart(
  jobId: string,
  current: Application | null,
  known: Known,
  mode: 'start' | 'retry',
): Application | null {
  if (mode === 'start' && current && current.stage !== 'withdrawn') return null;
  if (mode === 'retry' && current?.stage !== 'chosen') return null;
  const questions = mergeQuestions(current?.questions ?? [], known.job.deep);
  const fresh = current?.stage === 'withdrawn' || current === null;
  // A retry keeps its notes and clock; a start after a withdraw begins again, keeping versions.
  return settle(jobId, current, known, questions, {
    notes: fresh ? undefined : current.notes,
    startedAt: fresh ? known.now : current.startedAt,
    cvIds: current?.cvIds,
    currentCvId: current?.currentCvId,
  });
}

const carryOf = (current: Application): Carry => ({
  notes: current.notes,
  startedAt: current.startedAt,
  cvIds: current.cvIds,
  currentCvId: current.currentCvId,
});

/** The question being handled must exist and be open. */
function openQuestion(current: Application, questionId: string): Question | null {
  return (
    current.questions.find(
      (question) => question.id === questionId && question.answer === undefined,
    ) ?? null
  );
}

/** Records an answer or a skip; once nothing is open the application moves on. */
export function planAnswer(
  current: Application,
  questionIds: readonly string[],
  answer: NonNullable<Question['answer']>,
  known: Known,
): Application | null {
  if (current.stage !== 'needs_input') return null;
  if (questionIds.length === 0) return null;
  if (!questionIds.every((id) => openQuestion(current, id))) return null;
  const questions = current.questions.map((question) =>
    questionIds.includes(question.id) ? { ...question, answer } : question,
  );
  return settle(current.jobId, current, known, questions, carryOf(current));
}

/** Every open question skipped at once. */
export function planSkipAll(current: Application, known: Known): Application | null {
  const open = current.questions.filter((question) => question.answer === undefined);
  if (current.stage !== 'needs_input' || open.length === 0) return null;
  return planAnswer(
    current,
    open.map((question) => question.id),
    { kind: 'skipped' },
    known,
  );
}

/** A new CV for a ready application; the previous one stays as a version. Needs the header. */
export function planRegenerate(
  current: Application,
  notes: string | undefined,
  now: Date,
): Application | null {
  if (current.stage !== 'ready') return null;
  return withStage(current, current, 'generating', now, {
    questions: current.questions,
    ...carryOf(current),
    notes,
  });
}

/** Stops the application. Not from applied (undo that first) and not twice. */
export function planWithdraw(current: Application, now: Date): Application | null {
  if (current.stage === 'applied' || current.stage === 'withdrawn') return null;
  return withStage(current, current, 'withdrawn', now, {
    questions: current.questions,
    ...carryOf(current),
  });
}

/** After the files and `cvs` docs of a withdrawn application are deleted. */
export function planClearCvs(current: Application, now: Date): Application | null {
  if (current.stage !== 'withdrawn') return null;
  const next: Application = { ...current, cvIds: [], updatedAt: now };
  delete next.currentCvId;
  return next;
}

// ---- The CV worker's moves (M7 7D.2) ----
//
// Unlike the owner's moves above, these keep `attempt`: the worker's counter must survive every
// step it takes. `attempt` goes back to 0 only in `withStage`, i.e. on an owner's start, retry,
// answer or skip that settles, regenerate or withdraw.

const generating = (current: Application): boolean => current.stage === 'generating';

/** Counts one model call before it is made. Null when the stage moved or no attempt is left. */
export function planAttempt(current: Application, now: Date): Application | null {
  if (!generating(current) || current.attempt >= APPLICATION_LIMITS.maxAttempts) return null;
  return { ...current, attempt: current.attempt + 1, updatedAt: now };
}

/**
 * An invalid output with an attempt left: stays generating, with the codes the next call is told.
 * `attempt` stays as counted, so the next run's call is the second and the last.
 */
export function planRetry(
  current: Application,
  issues: readonly CvIssueCode[],
  now: Date,
): Application | null {
  if (!generating(current) || current.attempt >= APPLICATION_LIMITS.maxAttempts) return null;
  const next: Application = { ...current, updatedAt: now };
  if (issues.length > 0) next.lastIssues = [...issues];
  else delete next.lastIssues;
  return next;
}

/** Back to chosen with a reason; keeps `attempt` and the issue codes for the card. */
export function planBlocked(
  current: Application,
  code: BlockedCode,
  now: Date,
  issues: readonly CvIssueCode[] = [],
): Application | null {
  if (!generating(current)) return null;
  const next: Application = {
    ...current,
    stage: 'chosen',
    stageAt: now,
    updatedAt: now,
    blocked: { code, at: now },
  };
  if (issues.length > 0) next.lastIssues = [...issues];
  else delete next.lastIssues;
  return next;
}

/** A written CV: ready, with the new version current. Clears the issue codes. */
export function planReady(current: Application, cvId: string, now: Date): Application | null {
  if (!generating(current)) return null;
  if (current.cvIds.length >= APPLICATION_LIMITS.cvIds) return null;
  const next: Application = {
    ...current,
    stage: 'ready',
    stageAt: now,
    updatedAt: now,
    cvIds: [...current.cvIds, cvId],
    currentCvId: cvId,
  };
  delete next.blocked;
  delete next.lastIssues;
  return next;
}
