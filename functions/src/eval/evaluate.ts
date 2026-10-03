import {
  applyHardRules,
  checkTitle,
  CRITERIA_SEED_V1,
  DeepReadOutputSchema,
  factAliases,
  resolveDeepRead,
  scoreJob,
  triagePasses,
  TriageOutputSchema,
  type CriteriaContent,
  type Verdict,
} from '@hireframe/shared';

import { TITLE_CASES } from '../../../packages/shared/src/fixtures/title-cases.js';
import { llmCall, type LlmCallDeps } from '../llm/call.js';
import { LlmOutputError } from '../llm/errors.js';
import { s2System, s2User, s3System, s3User } from '../funnel/prompts.js';
import { caseJob, EVAL_FACTS, EVAL_NOW, EVAL_WORK_RIGHTS, type GoldenCase } from './cases.js';

/**
 * Runs each golden case through the real funnel logic (ADR-036): S1 rules, the S2 and S3 prompts
 * through `llm.call()`, and code-computed scores and verdicts. Only the transport differs between
 * CI (replayed recordings) and a local live run.
 */
export type EvalVerdict = Verdict | 'review';

export interface CaseResult {
  id: string;
  label: Verdict | null;
  verdict: EvalVerdict;
  stage: 's1' | 's2' | 's3';
  ruleId?: string;
  fit?: number;
  luck?: number;
  drift: boolean;
  costPence: number;
  injection: boolean;
}

export const EVAL_CRITERIA: CriteriaContent = CRITERIA_SEED_V1;

export async function evaluateCase(entry: GoldenCase, deps: LlmCallDeps): Promise<CaseResult> {
  const job = caseJob(entry);
  const base = { id: entry.id, label: entry.label, injection: entry.tags.includes('injection') };
  const s1 = applyHardRules({
    job,
    text: entry.posting.description,
    criteria: EVAL_CRITERIA,
    workRights: EVAL_WORK_RIGHTS.workRights,
    now: EVAL_NOW,
  });
  if (!s1.pass) {
    return { ...base, verdict: 'skip', stage: 's1', ruleId: s1.ruleId, drift: false, costPence: 0 };
  }
  let costPence = 0;
  try {
    const triage = await llmCall(deps, {
      purpose: 'triage',
      system: s2System(EVAL_CRITERIA, EVAL_FACTS, EVAL_WORK_RIGHTS),
      user: s2User(job, entry.posting.description),
      schema: TriageOutputSchema,
    });
    costPence += triage.costPence;
    if (!triagePasses(triage.data)) {
      return { ...base, verdict: 'skip', stage: 's2', drift: false, costPence };
    }
    const { toAlias, toId } = factAliases(EVAL_FACTS.map((fact) => fact.id));
    const deep = await llmCall(deps, {
      purpose: 'deepRead',
      system: s3System(EVAL_CRITERIA, EVAL_FACTS, toAlias, EVAL_WORK_RIGHTS),
      user: s3User(job, entry.posting.description, {
        lane: triage.data.lane,
        now: EVAL_NOW,
        descriptionKind: 'full',
        ...(job.postedAt ? { postedAt: job.postedAt } : {}),
        ...(entry.posting.companySize ? { companySize: entry.posting.companySize } : {}),
        ...(entry.posting.companyStage ? { companyStage: entry.posting.companyStage } : {}),
      }),
      schema: DeepReadOutputSchema,
      cacheSystem: true,
    });
    costPence += deep.costPence;
    const score = scoreJob({
      lane: triage.data.lane,
      deep: resolveDeepRead(deep.data, toId).deep,
      criteria: EVAL_CRITERIA,
      now: EVAL_NOW,
      ...(job.postedAt ? { postedAt: job.postedAt } : {}),
      ...(entry.posting.companySize ? { companySize: entry.posting.companySize } : {}),
      ...(s1.experienceAsk ? { experienceAsk: s1.experienceAsk } : {}),
    });
    return {
      ...base,
      verdict: score.verdict,
      stage: 's3',
      fit: score.fit,
      luck: score.luck,
      drift: score.drift,
      costPence,
    };
  } catch (error) {
    if (error instanceof LlmOutputError) {
      return {
        ...base,
        verdict: 'review',
        stage: 's3',
        drift: false,
        costPence: costPence + error.costPence,
      };
    }
    throw error;
  }
}

/** The excluded-title table shared with titles.test.ts: S1 alone, must be 100%. */
export function titleSuite(): { total: number; failures: string[] } {
  const failures = TITLE_CASES.filter(
    ([title, excludedBy]) => checkTitle(title, EVAL_CRITERIA).excludedBy !== excludedBy,
  ).map(([title]) => title);
  return { total: TITLE_CASES.length, failures };
}
