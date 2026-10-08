import {
  FUNNEL_LIMITS,
  JobSchema,
  type ExperienceAsk,
  type Job,
  type JobDeep,
  type JobFlag,
  type JobFunnelFields,
  type JobTriage,
  type QueueStage,
  type ReviewCode,
  type ScoreResult,
  type WaitState,
} from '@hireframe/shared';

import { PROMPT_VERSIONS } from './prompts.js';

/**
 * What each funnel outcome writes on a job (ADR-034, ADR-037). A patch sets fields and deletes
 * others, so a new judgement never leaves an old one's scores behind. Patches only ever name
 * funnel fields (`FUNNEL_JOB_FIELDS`) plus `stage`; the store refuses anything else.
 *
 * A final judgement (a verdict) replaces the previous verdict fields in one update. A job that is
 * only queued keeps its old verdict until the new one is written (re-score).
 */
export interface JobPatch {
  set: Partial<JobFunnelFields> & { stage?: Job['stage'] };
  clear: (keyof JobFunnelFields)[];
  /** Model spend to add to `costPence`. */
  addCostPence?: number;
}

export interface JudgeContext {
  criteriaVersion: number;
  now: Date;
}

/** Fields of a previous verdict, cleared by every new final judgement that doesn't set them. */
const SCORE_FIELDS = [
  'fitScore',
  'luckScore',
  'reason',
  'shortfall',
  'matchedFactIds',
  'gaps',
  'talkingPoints',
] as const satisfies readonly (keyof JobFunnelFields)[];

export function mergeFlags(
  existing: readonly JobFlag[] | undefined,
  add: readonly JobFlag[],
): JobFlag[] {
  return [...new Set([...(existing ?? []), ...add])].slice(0, FUNNEL_LIMITS.flags);
}

function final(ctx: JudgeContext): Partial<JobFunnelFields> {
  return { next: null, criteriaVersion: ctx.criteriaVersion, judgedAt: ctx.now };
}

export interface S1Outcome {
  flags: JobFlag[];
  sortAt: Date;
  experienceAsk?: ExperienceAsk;
}

/** S1 skipped the job: a final skip with the rule ID; earlier model output goes. */
export function s1SkipPatch(ruleId: string, outcome: S1Outcome, ctx: JudgeContext): JobPatch {
  return {
    set: {
      ...final(ctx),
      stage: 's1',
      verdict: 'skip',
      skip: { stage: 's1', ruleId },
      flags: outcome.flags,
      sortAt: outcome.sortAt,
      ...(outcome.experienceAsk ? { experienceAsk: outcome.experienceAsk } : {}),
    },
    clear: [
      ...SCORE_FIELDS,
      'review',
      'deep',
      'triage',
      'inputs',
      'promptVersion',
      'rescoreQueuedAt',
      ...(outcome.experienceAsk ? [] : (['experienceAsk'] as const)),
    ],
  };
}

/** S1 passed a new job: queued for S2. */
export function s1PassPatch(outcome: S1Outcome): JobPatch {
  return {
    set: {
      stage: 's1',
      next: 's2',
      flags: outcome.flags,
      sortAt: outcome.sortAt,
      ...(outcome.experienceAsk ? { experienceAsk: outcome.experienceAsk } : {}),
    },
    clear: outcome.experienceAsk ? [] : ['experienceAsk'],
  };
}

/**
 * A re-score passed S1 and needs a model call at `stage`: the job is queued, and everything else
 * (including its old verdict) stays until the new judgement is written.
 */
export function requeuePatch(stage: QueueStage, outcome: S1Outcome, now: Date): JobPatch {
  const patch = s1PassPatch(outcome);
  delete patch.set.stage;
  return { ...patch, set: { ...patch.set, next: stage, rescoreQueuedAt: now } };
}

/**
 * A queued job went stale before its turn: a free final skip, rule `freshness`. A job waiting for
 * a description got there through S3, so that is the stage it stopped at.
 */
export function expiredPatch(state: WaitState, ctx: JudgeContext): JobPatch {
  const stage = state === 'description' ? 's3' : state;
  return {
    set: { ...final(ctx), verdict: 'skip', skip: { stage, ruleId: 'freshness' } },
    clear: [...SCORE_FIELDS, 'review', 'rescoreQueuedAt'],
  };
}

/** The model's output was unusable after one retry: no verdict is guessed (FUNNEL.md). */
export function reviewPatch(
  stage: QueueStage,
  code: ReviewCode,
  ctx: JudgeContext,
  costPence: number,
): JobPatch {
  return {
    set: { ...final(ctx), review: { stage, code } },
    clear: ['rescoreQueuedAt'],
    ...(costPence > 0 ? { addCostPence: costPence } : {}),
  };
}

export interface S2Result {
  triage: JobTriage;
  fingerprint: string;
  costPence: number;
}

/** S2 said no: a final skip with the triage note. */
export function s2SkipPatch(result: S2Result, ctx: JudgeContext): JobPatch {
  return {
    set: {
      ...final(ctx),
      stage: 's2',
      verdict: 'skip',
      skip: {
        stage: 's2',
        ...(result.triage.note ? { note: result.triage.note.slice(0, FUNNEL_LIMITS.note) } : {}),
      },
      triage: result.triage,
      inputs: { s2: result.fingerprint },
      promptVersion: PROMPT_VERSIONS.s2,
    },
    clear: [...SCORE_FIELDS, 'review', 'deep', 'rescoreQueuedAt'],
    ...(result.costPence > 0 ? { addCostPence: result.costPence } : {}),
  };
}

/** S2 passed: queued for S3. An old verdict (re-score) stays until S3 replaces it. */
export function s2PassPatch(result: S2Result, job: Pick<Job, 'inputs'>): JobPatch {
  return {
    set: {
      stage: 's2',
      next: 's3',
      triage: result.triage,
      inputs: { s2: result.fingerprint, ...(job.inputs?.s3 ? { s3: job.inputs.s3 } : {}) },
    },
    clear: ['review'],
    ...(result.costPence > 0 ? { addCostPence: result.costPence } : {}),
  };
}

export interface S3Judgement {
  deep: JobDeep;
  score: ScoreResult;
  triage: JobTriage;
  fingerprints: { s2: string; s3: string };
  flags: JobFlag[];
  costPence: number;
}

/** A verdict from S3 output, freshly read or recomputed from storage. */
export function s3Patch(judgement: S3Judgement, ctx: JudgeContext): JobPatch {
  const { score } = judgement;
  return {
    set: {
      ...final(ctx),
      stage: 's3',
      verdict: score.verdict,
      fitScore: score.fit,
      luckScore: score.luck,
      reason: judgement.deep.reason,
      ...(score.shortfall ? { shortfall: score.shortfall } : {}),
      matchedFactIds: score.matchedFactIds,
      gaps: score.gaps,
      talkingPoints: judgement.deep.talkingPoints,
      deep: judgement.deep,
      triage: judgement.triage,
      inputs: judgement.fingerprints,
      flags: judgement.flags,
      promptVersion: PROMPT_VERSIONS.s3,
    },
    clear: [
      'skip',
      'review',
      'rescoreQueuedAt',
      ...(score.shortfall ? [] : (['shortfall'] as const)),
    ],
    ...(judgement.costPence > 0 ? { addCostPence: judgement.costPence } : {}),
  };
}

/**
 * S3 has no text to read (an alert job with no description, or one too short): no model call and
 * no slot, the job waits for a description (ADR-048). Earlier funnel output stays.
 */
export function needsDescriptionPatch(job: Pick<Job, 'flags'>): JobPatch {
  return {
    set: { next: 'description', flags: mergeFlags(job.flags, ['needs_description']) },
    clear: [],
  };
}

/** A dead `describe` claim released: the job waits for a description again (ADR-049). */
export function releasedClaimPatch(job: Pick<Job, 'flags'>): JobPatch {
  return { ...needsDescriptionPatch(job), clear: ['describingAt'] };
}

/**
 * The job as it will be once `patch` is written: fields set, fields cleared, spend added. The
 * store writes the same patch to Firestore; Lookup uses this to build a new job's first state.
 */
export function applyPatch(job: Job, patch: JobPatch, now: Date): Job {
  const cleared = new Set<string>(patch.clear);
  const next: Record<string, unknown> = Object.fromEntries(
    Object.entries({ ...job, ...patch.set }).filter(([name]) => !cleared.has(name)),
  );
  if (patch.addCostPence) next.costPence = (job.costPence ?? 0) + patch.addCostPence;
  next.updatedAt = now;
  return JobSchema.parse(next);
}
