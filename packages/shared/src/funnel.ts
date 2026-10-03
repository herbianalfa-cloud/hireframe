import { z } from 'zod';

/**
 * The funnel's data (docs/FUNNEL.md, ADR-032–034):
 * - model outputs for S2 (triage) and S3 (deep read), validated with zod before anything uses them;
 * - the verdict fields the funnel writes on `jobs/{jobId}`;
 * - per-stage counts on `runs/{runId}`.
 * Pure schemas only; jobs.ts builds `JobSchema` from these.
 */

export const VERDICTS = ['apply', 'near_miss', 'wildcard', 'skip'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const TRIAGE_LANES = ['primary', 'secondary', 'opportunistic', 'wildcard', 'none'] as const;
export type TriageLane = (typeof TRIAGE_LANES)[number];

export const SENIORITIES = ['intern', 'graduate', 'junior', 'mid', 'senior', 'unclear'] as const;
export const REQUIREMENT_LEVELS = ['must', 'nice'] as const;
export const REQUIREMENT_TYPES = [
  'domain',
  'tool',
  'skill',
  'seniority',
  'credential',
  'logistics',
] as const;
export const MATCHES = ['met', 'partial', 'missing'] as const;
export const GAP_TYPES = ['tool', 'sector', 'domain', 'seniority', 'hard-blocker'] as const;
export type GapType = (typeof GAP_TYPES)[number];
export const EMPLOYER_KINDS = ['big_brand', 'small', 'other'] as const;

/** Stages that can queue a job (`next`) and that a job can stop at. */
export const QUEUE_STAGES = ['s2', 's3'] as const;
export type QueueStage = (typeof QUEUE_STAGES)[number];
export const FUNNEL_STAGES = ['s1', 's2', 's3'] as const;

export const FUNNEL_LIMITS = {
  /** S2 sees at most this much description (FUNNEL.md). */
  s2Description: 600,
  /** S3 sees at most this much description. */
  s3Description: 12_000,
  requirements: 20,
  requirementText: 200,
  factRefs: 8,
  talkingPoints: 3,
  talkingPoint: 200,
  reason: 300,
  note: 150,
  blockers: 5,
  blockerText: 100,
  gaps: 20,
  matchedFactIds: 50,
  flags: 10,
  shortfall: 200,
  /** `run.perStage.s1.byRule` keeps at most this many rule IDs. */
  byRule: 50,
} as const;

const Text = (max: number) => z.string().trim().min(1).max(max);
const Score = z.number().min(0).max(10);
const Count = z.int().min(0);

// ---- Model outputs ----

/** S2 triage output (docs/FUNNEL.md "S2"). */
export const TriageOutputSchema = z.object({
  lane: z.enum(TRIAGE_LANES),
  seniority: z.enum(SENIORITIES),
  blockers: z.array(Text(FUNNEL_LIMITS.blockerText)).max(FUNNEL_LIMITS.blockers),
  pass: z.boolean(),
  triageScore: Score,
  note: z.string().trim().max(FUNNEL_LIMITS.note),
});
export type TriageOutput = z.infer<typeof TriageOutputSchema>;

/** A profile fact as the S3 prompt names it: `F1`, `F2`, … (aliases, mapped back in code). */
export const FACT_ALIAS_PATTERN = /^F[1-9]\d{0,2}$/;

/**
 * S3 deep-read output. Each requirement carries its own gap type when it isn't met, so code can
 * apply the domain and hard-blocker caps per must-have (ADR-034).
 */
export const DeepReadOutputSchema = z.object({
  requirements: z
    .array(
      z.object({
        text: Text(FUNNEL_LIMITS.requirementText),
        level: z.enum(REQUIREMENT_LEVELS),
        type: z.enum(REQUIREMENT_TYPES),
        match: z.enum(MATCHES),
        gap: z.enum(GAP_TYPES).nullable(),
        // Checked against the alias map in code (unknown ones are dropped), not by a pattern here,
        // so the JSON schema sent to the API stays simple.
        factRefs: z.array(z.string().max(8)).max(FUNNEL_LIMITS.factRefs),
      }),
    )
    .max(FUNNEL_LIMITS.requirements),
  rubric: z.object({
    evidence: z.number().min(0).max(2),
    companyFit: z.number().min(0).max(1),
  }),
  employer: z.enum(EMPLOYER_KINDS),
  fitScore: Score,
  luckScore: Score,
  verdict: z.enum(VERDICTS),
  reason: Text(FUNNEL_LIMITS.reason),
  talkingPoints: z.array(Text(FUNNEL_LIMITS.talkingPoint)).max(FUNNEL_LIMITS.talkingPoints),
});
export type DeepReadOutput = z.infer<typeof DeepReadOutputSchema>;

// ---- Stored on the job ----

export const JOB_FLAGS = [
  /** No posting date: freshness used the first-seen date as a lower bound. */
  'freshness_unknown',
  /** A years-of-experience ask whose wording was neither clearly required nor optional. */
  'experience_ambiguous',
  /** Right-to-work wording, but the owner hasn't set their work rights. */
  'work_rights_unknown',
  /** S3 read a snippet, not the full description. */
  'snippet_only',
  /** The model's fit or luck differed from code's by more than 2. */
  'score_drift',
  /** A requirement claimed met or partial without a real fact was downgraded to missing. */
  'unsupported_match',
] as const;
export type JobFlag = (typeof JOB_FLAGS)[number];

export const ExperienceAskSchema = z.object({
  years: z.int().min(0).max(50),
  /** True when phrased as required; false for preferred or ambiguous asks. */
  required: z.boolean(),
});
export type ExperienceAsk = z.infer<typeof ExperienceAskSchema>;

export const JobTriageSchema = TriageOutputSchema;
export type JobTriage = z.infer<typeof JobTriageSchema>;

export const JobRequirementSchema = z.object({
  text: Text(FUNNEL_LIMITS.requirementText),
  level: z.enum(REQUIREMENT_LEVELS),
  type: z.enum(REQUIREMENT_TYPES),
  match: z.enum(MATCHES),
  gap: z.enum(GAP_TYPES).nullable(),
  factIds: z.array(z.string().min(1)).max(FUNNEL_LIMITS.factRefs),
});
export type JobRequirement = z.infer<typeof JobRequirementSchema>;

/**
 * The validated S3 output, with fact aliases mapped to real IDs (unknown ones dropped). Kept so a
 * re-score can recompute fit, luck and verdict in code without calling the model again.
 */
export const JobDeepSchema = z.object({
  requirements: z.array(JobRequirementSchema).max(FUNNEL_LIMITS.requirements),
  rubric: DeepReadOutputSchema.shape.rubric,
  employer: z.enum(EMPLOYER_KINDS),
  model: z.object({ fit: Score, luck: Score, verdict: z.enum(VERDICTS) }),
  reason: Text(FUNNEL_LIMITS.reason),
  talkingPoints: z.array(Text(FUNNEL_LIMITS.talkingPoint)).max(FUNNEL_LIMITS.talkingPoints),
});
export type JobDeep = z.infer<typeof JobDeepSchema>;

export const JobGapSchema = z.object({
  type: z.enum(GAP_TYPES),
  text: Text(FUNNEL_LIMITS.requirementText),
});
export type JobGap = z.infer<typeof JobGapSchema>;

/** Why a job stopped: the stage and, for rules, the rule ID (PRD R6). */
export const JobSkipSchema = z.object({
  stage: z.enum(FUNNEL_STAGES),
  ruleId: z
    .string()
    .regex(/^[a-z0-9:_-]{1,80}$/)
    .exactOptional(),
  note: z.string().max(FUNNEL_LIMITS.note).exactOptional(),
});
export type JobSkip = z.infer<typeof JobSkipSchema>;

export const REVIEW_CODES = [
  'refusal',
  'max_tokens',
  'no_text',
  'invalid_json',
  'schema',
  'error',
] as const;
export type ReviewCode = (typeof REVIEW_CODES)[number];

/** The model's output was unusable after one retry: never guess, ask a human (FUNNEL.md). */
export const JobReviewSchema = z.object({
  stage: z.enum(QUEUE_STAGES),
  code: z.enum(REVIEW_CODES),
});
export type JobReview = z.infer<typeof JobReviewSchema>;

/** SHA-256 hex of the model, prompt version and exact system prompt a stage used (rescore). */
export const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export const JobInputsSchema = z.object({
  s2: z.string().regex(FINGERPRINT_PATTERN).exactOptional(),
  s3: z.string().regex(FINGERPRINT_PATTERN).exactOptional(),
});

/** Funnel fields on `jobs/{jobId}`; all optional, because M3 wrote jobs without them. */
export const JobFunnelFieldsSchema = z.object({
  /** The stage this job waits for; null or absent when it isn't queued. */
  next: z.enum(QUEUE_STAGES).nullable().exactOptional(),
  /** `postedAt` if known, else `firstSeenAt`: queue order and freshness (set by S1). */
  sortAt: z.date().exactOptional(),
  experienceAsk: ExperienceAskSchema.exactOptional(),
  flags: z.array(z.enum(JOB_FLAGS)).max(FUNNEL_LIMITS.flags).exactOptional(),
  triage: JobTriageSchema.exactOptional(),
  deep: JobDeepSchema.exactOptional(),
  inputs: JobInputsSchema.exactOptional(),
  verdict: z.enum(VERDICTS).exactOptional(),
  fitScore: Score.exactOptional(),
  luckScore: Score.exactOptional(),
  reason: z.string().max(FUNNEL_LIMITS.reason).exactOptional(),
  /** Near misses: what fell short, in plain words (FUNNEL.md). */
  shortfall: z.string().max(FUNNEL_LIMITS.shortfall).exactOptional(),
  matchedFactIds: z.array(z.string().min(1)).max(FUNNEL_LIMITS.matchedFactIds).exactOptional(),
  gaps: z.array(JobGapSchema).max(FUNNEL_LIMITS.gaps).exactOptional(),
  talkingPoints: z
    .array(Text(FUNNEL_LIMITS.talkingPoint))
    .max(FUNNEL_LIMITS.talkingPoints)
    .exactOptional(),
  skip: JobSkipSchema.exactOptional(),
  review: JobReviewSchema.exactOptional(),
  criteriaVersion: z.int().min(1).exactOptional(),
  promptVersion: z.string().min(1).max(60).exactOptional(),
  judgedAt: z.date().exactOptional(),
  /** Model spend on this job so far, in pence. */
  costPence: z.number().min(0).exactOptional(),
  /** Set while a re-score waits for a model call; the old verdict stays until it's replaced. */
  rescoreQueuedAt: z.date().exactOptional(),
});
export type JobFunnelFields = z.infer<typeof JobFunnelFieldsSchema>;

/** The only fields the funnel may write on a job (besides `stage` and `updatedAt`). */
export const FUNNEL_JOB_FIELDS = Object.keys(
  JobFunnelFieldsSchema.shape,
) as readonly (keyof JobFunnelFields)[];

// ---- Run counts ----

export const S1CountsSchema = z.object({
  in: Count,
  passed: Count,
  skipped: Count,
  byRule: z.record(z.string().max(80), Count),
});
export type S1Counts = z.infer<typeof S1CountsSchema>;

export const S2CountsSchema = z.object({
  in: Count,
  passed: Count,
  skipped: Count,
  /** Queued jobs that went stale before their turn (rule `freshness`, no model call). */
  expired: Count,
  review: Count,
  /** Still waiting for S2 after this run. */
  queued: Count,
  costPence: z.number().min(0),
  durationMs: Count,
});
export type S2Counts = z.infer<typeof S2CountsSchema>;

export const HydrateCountsSchema = z.object({ attempted: Count, ok: Count, failed: Count });
export type HydrateCounts = z.infer<typeof HydrateCountsSchema>;

export const S3CountsSchema = z.object({
  in: Count,
  apply: Count,
  near_miss: Count,
  wildcard: Count,
  skip: Count,
  expired: Count,
  review: Count,
  /** Still waiting for S3 after this run. */
  queued: Count,
  /** Jobs whose model scores differed from code's by more than 2. */
  drift: Count,
  /** Jobs judged from stored S3 output with no model call (re-score). */
  recomputed: Count,
  costPence: z.number().min(0),
  durationMs: Count,
});
export type S3Counts = z.infer<typeof S3CountsSchema>;

export const RescoreCountsSchema = z.object({
  jobs: Count,
  s1Changed: Count,
  recomputed: Count,
  queuedS2: Count,
  queuedS3: Count,
  unchanged: Count,
});
export type RescoreCounts = z.infer<typeof RescoreCountsSchema>;

export const STOP_REASONS = [
  'run_budget',
  'monthly_cap',
  'deep_pause',
  'deadline',
  'no_criteria',
  'no_profile',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const RunBudgetSchema = z.object({
  /** Pence reserved for this run on `usage/{month}`. */
  leasePence: z.number().min(0),
  /** Pence actually spent. */
  usedPence: z.number().min(0),
  /** Why the model stages stopped early, if they did. */
  stoppedBy: z.enum(STOP_REASONS).exactOptional(),
});
export type RunBudget = z.infer<typeof RunBudgetSchema>;

export const RUN_FLAGS = ['spend_80', 'deep_pause'] as const;
export type RunFlag = (typeof RUN_FLAGS)[number];

/** What `scanNow` and `rescore` return about the funnel, for the System screen. */
export const FunnelSummarySchema = z.object({
  s1: z.object({ passed: Count, skipped: Count }),
  s2: z.object({ passed: Count, skipped: Count }),
  s3: z.object({ apply: Count, near_miss: Count, wildcard: Count, skip: Count }),
  review: Count,
  queued: z.object({ s2: Count, s3: Count }),
  costPence: z.number().min(0),
  stoppedBy: z.enum(STOP_REASONS).exactOptional(),
});
export type FunnelSummary = z.infer<typeof FunnelSummarySchema>;
