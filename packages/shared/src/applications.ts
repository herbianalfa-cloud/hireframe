import { z } from 'zod';

import { fnv1a64 } from './dedupe.js';
import {
  FUNNEL_LIMITS,
  MATCHES,
  REQUIREMENT_LEVELS,
  REQUIREMENT_TYPES,
  VERDICTS,
  type JobRequirement,
} from './funnel.js';
import { foldText } from './normalise.js';

/**
 * The application pipeline's data (M7, docs/plans/m7-plan.md): `applications/{jobId}`, one per job
 * the owner chose to apply to. Stages move on the server (the `application` callable and the CV
 * worker), except the Applied mirror, which the client writes beside the job's own status change.
 * Pure schemas and the question builder only; no I/O.
 */

export const APPLICATION_STAGES = [
  'chosen',
  'needs_input',
  'generating',
  'ready',
  'applied',
  'withdrawn',
] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

/** Stages a job can come back to from Applied (`stageBefore`). */
export const RESTORABLE_STAGES = ['chosen', 'needs_input', 'generating', 'ready'] as const;

export const BLOCKED_CODES = [
  'cap',
  'daily_cap',
  'no_deep_read',
  'cv_header_missing',
  'invalid_output',
  'attempts_exhausted',
  'error',
] as const;
export type BlockedCode = (typeof BLOCKED_CODES)[number];

/** Why `validateCv` refused an output (cv.ts); kept on the application for the retry. */
export const CV_ISSUE_CODES = [
  'uncited',
  'unknown_fact',
  'wrong_fact_type',
  'unsupported_number',
  'unsupported_text',
  'contact_in_text',
  'too_long',
  'unsupported_char',
] as const;
export type CvIssueCode = (typeof CV_ISSUE_CODES)[number];

export const APPLICATION_LIMITS = {
  /** Questions asked about one job. */
  maxQuestions: 5,
  /** Model calls one job may cost (the worker counts an attempt before it calls). */
  maxAttempts: 2,
  requirement: FUNNEL_LIMITS.requirementText,
  notes: 500,
  /** Answer text sent to the `application` callable. */
  answer: 2_000,
  /** CV versions kept per application. */
  cvIds: 50,
} as const;

export const QuestionAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('fact'),
    factIds: z.array(z.string().min(1)).min(1).max(5),
  }),
  z.strictObject({ kind: z.literal('skipped') }),
]);
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

export const QuestionSchema = z.strictObject({
  id: z.string().regex(/^q-[0-9a-f]{12}$/),
  /** The requirement as the owner reads it. Never put into a prompt. */
  requirement: z.string().trim().min(1).max(APPLICATION_LIMITS.requirement),
  level: z.enum(REQUIREMENT_LEVELS),
  type: z.enum(REQUIREMENT_TYPES),
  match: z.enum(MATCHES),
  answer: QuestionAnswerSchema.exactOptional(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const BlockedSchema = z.strictObject({
  code: z.enum(BLOCKED_CODES),
  at: z.date(),
});
export type Blocked = z.infer<typeof BlockedSchema>;

export const ApplicationSchema = z
  .strictObject({
    jobId: z.string().min(1),
    /** A snapshot for lists, so Pipeline reads no jobs. */
    job: z.strictObject({
      title: z.string().min(1).max(200),
      company: z.string().min(1).max(200),
      verdict: z.enum(VERDICTS),
    }),
    stage: z.enum(APPLICATION_STAGES),
    /** Only while `stage` is `applied`: where Undo goes back to. */
    stageBefore: z.enum(RESTORABLE_STAGES).exactOptional(),
    stageAt: z.date(),
    startedAt: z.date(),
    updatedAt: z.date(),
    blocked: BlockedSchema.exactOptional(),
    questions: z.array(QuestionSchema).max(APPLICATION_LIMITS.maxQuestions),
    attempt: z.int().min(0).max(APPLICATION_LIMITS.maxAttempts),
    /** Issue codes from the last invalid output, appended to the next call's prompt. */
    lastIssues: z.array(z.enum(CV_ISSUE_CODES)).max(CV_ISSUE_CODES.length).exactOptional(),
    notes: z.string().trim().min(1).max(APPLICATION_LIMITS.notes).exactOptional(),
    cvIds: z.array(z.string().min(1)).max(APPLICATION_LIMITS.cvIds),
    currentCvId: z.string().min(1).exactOptional(),
    schemaVersion: z.literal(1),
  })
  .refine((application) => (application.stage === 'applied') === 'stageBefore' in application, {
    message: 'stageBefore is set exactly while the stage is applied',
    path: ['stageBefore'],
  });
export type Application = z.infer<typeof ApplicationSchema>;

// ---- Questions ----

/** `q-` plus 12 hex digits of a hash of the requirement text, folded so spacing and case don't matter. */
export function questionId(requirementText: string): string {
  const folded = foldText(requirementText).replace(/\s+/g, ' ').trim();
  return `q-${fnv1a64(folded).slice(0, 12)}`;
}

const LEVEL_RANK: Readonly<Record<JobRequirement['level'], number>> = { must: 0, nice: 1 };
const MATCH_RANK: Readonly<Record<JobRequirement['match'], number>> = {
  missing: 0,
  partial: 1,
  met: 2,
};

/**
 * What to ask the owner before writing a CV, from the S3 requirements the job already carries
 * (no model call). Requirements already met and logistics (visa, location, pay) are not asked.
 * Must-haves come before nice-to-haves, missing before partial, then in the job's own order;
 * at most `max`, and one question per distinct requirement text.
 */
export function questionsFromRequirements(
  deep: { readonly requirements: readonly JobRequirement[] },
  max: number = APPLICATION_LIMITS.maxQuestions,
): Question[] {
  const seen = new Set<string>();
  const candidates: { question: Question; order: number }[] = [];
  deep.requirements.forEach((requirement, order) => {
    if (requirement.match === 'met' || requirement.type === 'logistics') return;
    const id = questionId(requirement.text);
    if (seen.has(id)) return;
    seen.add(id);
    candidates.push({
      order,
      question: {
        id,
        requirement: requirement.text,
        level: requirement.level,
        type: requirement.type,
        match: requirement.match,
      },
    });
  });
  return candidates
    .sort(
      (a, b) =>
        LEVEL_RANK[a.question.level] - LEVEL_RANK[b.question.level] ||
        MATCH_RANK[a.question.match] - MATCH_RANK[b.question.match] ||
        a.order - b.order,
    )
    .slice(0, max)
    .map(({ question }) => question);
}
