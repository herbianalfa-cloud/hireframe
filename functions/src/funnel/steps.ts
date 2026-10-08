import {
  applyHardRules,
  DeepReadOutputSchema,
  factAliases,
  resolveDeepRead,
  scoreJob,
  TriageOutputSchema,
  type CriteriaVersion,
  type FunnelFact,
  type Job,
  type JobDeep,
  type JobFlag,
  type JobTriage,
  type S1Result,
  type WorkRightsSetting,
} from '@hireframe/shared';

import { MODELS } from '../config.js';
import { llmCall, type LlmCallDeps, type LlmCallResult } from '../llm/call.js';
import { log } from '../log.js';
import { mergeFlags, s3Patch, type JobPatch, type JudgeContext } from './judgement.js';
import { fingerprint, PROMPT_VERSIONS, s2System, s2User, s3System, s3User } from './prompts.js';

/**
 * The funnel's steps as functions of the criteria and the profile (ADR-049): S1's rules, the S2
 * triage call, the S3 deep read and the judgement, built once from `buildFunnelContext`. A scan's
 * `runFunnel` and the `lookup` callable both call these, so the same prompts, fingerprints and
 * scoring apply wherever a job is judged and a later re-score can reuse either's model output.
 * Nothing here reads or writes the store; callers own queues, leases, writes and error handling.
 */

/** What the steps need to know about a job's company (from `companies/{id}`). */
export interface CompanyFacts {
  size?: string;
  stage?: string;
}

export interface DeepReadInput {
  text: string;
  /** `snippet` tells the model only part of the posting is available. */
  descriptionKind: Job['descriptionKind'];
  company?: CompanyFacts;
  now: Date;
}

export interface JudgeOptions {
  flags: JobFlag[];
  costPence: number;
  s2Fingerprint: string;
  company?: CompanyFacts;
  now: Date;
}

export interface FunnelContext {
  criteria: CriteriaVersion;
  /** Fact alias → real fact ID, for the S3 output. */
  toId: ReadonlyMap<string, string>;
  systems: { s2: string; s3: string };
  fingerprints: { s2: string; s3: string };
  /** S1: the free rules on the job and its description text. */
  rules(job: Job, text: string, now: Date): S1Result;
  /** S2: the cheap triage call. Throws what `llmCall` throws. */
  triage(deps: LlmCallDeps, job: Job, text: string): Promise<LlmCallResult<JobTriage>>;
  /** S3: the deep read, with the model's fact references resolved. Throws what `llmCall` throws. */
  deepRead(
    deps: LlmCallDeps,
    job: Job,
    triage: JobTriage,
    input: DeepReadInput,
  ): Promise<{
    model: string;
    costPence: number;
    deep: JobDeep;
    downgraded: number;
    unknownRefs: number;
  }>;
  /** A verdict from S3 output (fresh or stored): fit, luck and verdict are computed in code. */
  judge(
    job: Job,
    triage: JobTriage,
    deep: JobDeep,
    options: JudgeOptions,
    ctx: JudgeContext,
  ): JobPatch;
}

export function buildFunnelContext(
  criteria: CriteriaVersion,
  facts: readonly FunnelFact[],
  workRights: WorkRightsSetting | null,
): FunnelContext {
  const { toAlias, toId } = factAliases(facts.map((fact) => fact.id));
  const systems = {
    s2: s2System(criteria, facts, workRights),
    s3: s3System(criteria, facts, toAlias, workRights),
  };
  const fingerprints = {
    s2: fingerprint(MODELS.triage, PROMPT_VERSIONS.s2, systems.s2),
    s3: fingerprint(MODELS.deepRead, PROMPT_VERSIONS.s3, systems.s3),
  };

  return {
    criteria,
    toId,
    systems,
    fingerprints,

    rules: (job, text, now) =>
      applyHardRules({
        job,
        text,
        criteria,
        workRights: workRights?.workRights ?? null,
        now,
      }),

    triage: (deps, job, text) =>
      llmCall(deps, {
        purpose: 'triage',
        system: systems.s2,
        user: s2User(job, text),
        schema: TriageOutputSchema,
      }),

    async deepRead(deps, job, triage, input) {
      const result = await llmCall(deps, {
        purpose: 'deepRead',
        system: systems.s3,
        user: s3User(job, input.text, {
          lane: triage.lane,
          now: input.now,
          descriptionKind: input.descriptionKind,
          ...(job.postedAt ? { postedAt: job.postedAt } : {}),
          ...(input.company?.size ? { companySize: input.company.size } : {}),
          ...(input.company?.stage ? { companyStage: input.company.stage } : {}),
        }),
        schema: DeepReadOutputSchema,
        cacheSystem: true,
      });
      const { deep, downgraded, unknownRefs } = resolveDeepRead(result.data, toId);
      if (downgraded > 0 || unknownRefs > 0) {
        log.warn('funnel.unsupported_match', { downgraded, unknownRefs });
      }
      return {
        model: result.model,
        costPence: result.costPence,
        deep,
        downgraded,
        unknownRefs,
      };
    },

    judge(job, triage, deep, options, ctx) {
      const score = scoreJob({
        lane: triage.lane,
        deep,
        criteria,
        now: options.now,
        ...(job.postedAt ? { postedAt: job.postedAt } : {}),
        ...(options.company?.size ? { companySize: options.company.size } : {}),
        ...(job.experienceAsk ? { experienceAsk: job.experienceAsk } : {}),
        workRights: workRights?.workRights ?? null,
      });
      if (score.drift) {
        log.warn('funnel.score_drift', {
          modelFit: deep.model.fit,
          fit: score.fit,
          modelLuck: deep.model.luck,
          luck: score.luck,
        });
      }
      return s3Patch(
        {
          deep,
          score,
          triage,
          fingerprints: { s2: options.s2Fingerprint, s3: fingerprints.s3 },
          flags: mergeFlags(options.flags, score.drift ? ['score_drift'] : []),
          costPence: options.costPence,
        },
        ctx,
      );
    },
  };
}
