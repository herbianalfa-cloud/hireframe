import {
  applyHardRules,
  DeepReadOutputSchema,
  factAliases,
  freshnessCutoff,
  FUNNEL_LIMITS,
  isExpired,
  monthKey,
  QUEUE_STAGES,
  resolveDeepRead,
  scoreJob,
  triagePasses,
  TriageOutputSchema,
  type CriteriaVersion,
  type FunnelFact,
  type FunnelSummary,
  type HydrateCounts,
  type Job,
  type JobDeep,
  type JobFlag,
  type JobTriage,
  type QueueStage,
  type RescoreCounts,
  type RunBudget,
  type RunFlag,
  type S1Counts,
  type S1Result,
  type S2Counts,
  type S3Counts,
  type StopReason,
  type WorkRightsSetting,
} from '@hireframe/shared';

import { FUNNEL, MODELS, type FunnelLimits } from '../config.js';
import { llmCall, type LlmCallDeps } from '../llm/call.js';
import { LlmOutputError, RunBudgetExceededError, SpendCapExceededError } from '../llm/errors.js';
import { createRunLease, type LeaseStage, type RunLease } from '../llm/lease.js';
import type { LlmTransport } from '../llm/transport.js';
import type { LeaseStore } from '../llm/usage-store.js';
import { errorFields, log } from '../log.js';
import { eachLimited } from '../sources/types.js';
import {
  expiredPatch,
  mergeFlags,
  requeuePatch,
  reviewPatch,
  s1PassPatch,
  s1SkipPatch,
  s2PassPatch,
  s2SkipPatch,
  s3Patch,
  type JobPatch,
  type JudgeContext,
  type S1Outcome,
} from './judgement.js';
import { createPacer } from './pacer.js';
import { fingerprint, PROMPT_VERSIONS, s2System, s2User, s3System, s3User } from './prompts.js';

/**
 * The funnel for one run (docs/FUNNEL.md, ADR-032–037): S1 on jobs no stage has judged (the M3
 * backlog the first time), then S2 and S3 on their queues inside the run's spend lease, stage
 * shares, count caps and deadlines. S2 takes the newest jobs first, S3 the best triage scores;
 * whatever doesn't fit stays queued (`next`) for the next run. After S1 and before the lease, an
 * expiry sweep skips every queued job past `freshness_days` for free, however deep in the queue. A re-score first re-runs S1 on the last 14 days and recomputes
 * verdicts from stored model output wherever the prompts haven't changed.
 *
 * Model and budget problems end a stage and are reported, never thrown. Store errors propagate
 * to the caller, which records the run as partial.
 */

export interface StoredJob {
  id: string;
  job: Job;
}

export interface CompanyInfo {
  size?: string;
  stage?: string;
}

export interface FunnelStore {
  /** Active facts and the owner's work-rights setting. */
  loadProfile(): Promise<{ facts: FunnelFact[]; workRights: WorkRightsSetting | null }>;
  /** Jobs no stage has judged yet, newest first. */
  s0Jobs(limit: number): Promise<StoredJob[]>;
  /** Jobs waiting for `stage`: S2 newest first, S3 by triage score then newest. */
  queued(stage: QueueStage, limit: number): Promise<StoredJob[]>;
  /**
   * Jobs waiting for `stage` whose `sortAt` is before `before`, newest first (the expiry sweep).
   * Served by the `(next, sortAt desc)` index for both stages.
   */
  staleQueued(stage: QueueStage, before: Date, limit: number): Promise<StoredJob[]>;
  /** Jobs first seen at or after `since` (re-score). */
  recentJobs(since: Date, limit: number): Promise<StoredJob[]>;
  /** Description text by job ID (missing descriptions are left out). */
  descriptions(jobIds: readonly string[]): Promise<Map<string, string>>;
  companies(ids: readonly string[]): Promise<Map<string, CompanyInfo>>;
  /** Applies patches (funnel fields and `stage` only). Returns how many failed. */
  apply(updates: readonly { jobId: string; patch: JobPatch }[], now: Date): Promise<number>;
  /** How many jobs wait for each stage. */
  queueCounts(): Promise<Record<QueueStage, number>>;
}

/** Full text for jobs that only have a snippet (Reed details, ADR-029). */
export interface Hydrator {
  /** Fetches and saves the job's full text; null when it has none or the budget is spent. */
  fullText(entry: StoredJob): Promise<string | null>;
  counts(): HydrateCounts;
  /** Saves quota counters; called once at the end. */
  finish(): Promise<void>;
}

export interface FunnelDeps {
  store: FunnelStore;
  leases: LeaseStore;
  transport: LlmTransport;
  fxUsdToGbp: number;
  monthlyCapPence: number;
  limits: FunnelLimits;
  /** The current criteria version, or null before criteria exist. */
  criteria: CriteriaVersion | null;
  hydrator: Hydrator | null;
  now: () => Date;
  /** Epoch ms, for deadlines and pacing. */
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  /** When the run started (epoch ms); stage deadlines count from here. */
  startedAtMs: number;
}

export interface FunnelOptions {
  runId: string;
  /** Re-score jobs first seen since this date before the queues (the `rescore` callable). */
  rescoreSince?: Date;
}

export interface FunnelOutcome {
  perStage: {
    s1: S1Counts;
    s2: S2Counts;
    hydrate: HydrateCounts;
    s3: S3Counts;
    rescore?: RescoreCounts;
  };
  budget: RunBudget;
  flags: RunFlag[];
  costPence: number;
  summary: FunnelSummary;
  /** Job writes that failed (logged); the run is partial when there are any. */
  failedWrites: number;
  /** The expiry sweep hit a store error (logged); the stages still ran, and the run is partial. */
  sweepFailed: boolean;
}

/** Patches are written in small groups, so a run killed mid-stage keeps what it paid for. */
const FLUSH_EVERY = 20;
/** A stage stops after this many model calls in a row fail for reasons other than output. */
const MAX_CONSECUTIVE_ERRORS = 3;
/** Flags a re-score carries over from the earlier deep read. */
const DEEP_FLAGS: readonly JobFlag[] = ['snippet_only', 'unsupported_match'];

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function s1Outcome(result: S1Result): S1Outcome {
  return {
    flags: result.flags,
    sortAt: result.sortAt,
    ...(result.experienceAsk ? { experienceAsk: result.experienceAsk } : {}),
  };
}

function emptyCounts() {
  const s1: S1Counts = { in: 0, passed: 0, skipped: 0, byRule: {} };
  const s2: S2Counts = {
    in: 0,
    passed: 0,
    skipped: 0,
    expired: 0,
    review: 0,
    queued: 0,
    costPence: 0,
    durationMs: 0,
  };
  const s3: S3Counts = {
    in: 0,
    apply: 0,
    near_miss: 0,
    wildcard: 0,
    skip: 0,
    expired: 0,
    review: 0,
    queued: 0,
    drift: 0,
    recomputed: 0,
    costPence: 0,
    durationMs: 0,
  };
  return { s1, s2, s3 };
}

export async function runFunnel(deps: FunnelDeps, options: FunnelOptions): Promise<FunnelOutcome> {
  const { store } = deps;
  const { s1, s2, s3 } = emptyCounts();
  const flags = new Set<RunFlag>();
  const stops: { setup?: StopReason; s2?: StopReason; s3?: StopReason } = {};
  let rescore: RescoreCounts | undefined;
  let lease: RunLease | null = null;

  // ---- Writes: buffered, flushed every few jobs and at the end ----
  let pending: { jobId: string; patch: JobPatch }[] = [];
  let failedWrites = 0;
  let sweepFailed = false;
  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    failedWrites += await store.apply(batch, deps.now());
  };
  const write = async (jobId: string, patch: JobPatch) => {
    pending.push({ jobId, patch });
    if (pending.length >= FLUSH_EVERY) await flush();
  };

  if (!deps.criteria) {
    stops.setup = 'no_criteria';
    return finish();
  }
  const criteria: CriteriaVersion = deps.criteria;

  const ctx = (): JudgeContext => ({ criteriaVersion: criteria.version, now: deps.now() });
  const { facts, workRights } = await store.loadProfile();
  const { toAlias, toId } = factAliases(facts.map((fact) => fact.id));
  const systems = {
    s2: s2System(criteria, facts, workRights),
    s3: s3System(criteria, facts, toAlias, workRights),
  };
  const fingerprints = {
    s2: fingerprint(MODELS.triage, PROMPT_VERSIONS.s2, systems.s2),
    s3: fingerprint(MODELS.deepRead, PROMPT_VERSIONS.s3, systems.s3),
  };
  const rules = (entry: StoredJob, text: string) =>
    applyHardRules({
      job: entry.job,
      text,
      criteria,
      workRights: workRights?.workRights ?? null,
      now: deps.now(),
    });

  // ---- Reads shared by the stages ----
  const companyCache = new Map<string, CompanyInfo>();
  async function loadCompanies(jobs: readonly StoredJob[]): Promise<void> {
    const ids = [...new Set(jobs.flatMap((entry) => entry.job.companyId ?? []))].filter(
      (id) => !companyCache.has(id),
    );
    for (const part of chunks(ids, FUNNEL.readChunk)) {
      const found = await store.companies(part);
      for (const id of part) companyCache.set(id, found.get(id) ?? {});
    }
  }
  async function loadTexts(jobs: readonly StoredJob[]): Promise<Map<string, string>> {
    const texts = new Map<string, string>();
    for (const part of chunks(jobs, FUNNEL.readChunk)) {
      for (const [id, text] of await store.descriptions(part.map((entry) => entry.id))) {
        texts.set(id, text);
      }
    }
    return texts;
  }

  /** A verdict from S3 output (fresh or stored), with fit, luck and verdict computed in code. */
  function judge(
    job: Job,
    triage: JobTriage,
    deep: JobDeep,
    options: { flags: JobFlag[]; costPence: number; s2Fingerprint: string },
  ): JobPatch {
    const company = job.companyId ? companyCache.get(job.companyId) : undefined;
    const score = scoreJob({
      lane: triage.lane,
      deep,
      criteria,
      now: deps.now(),
      ...(job.postedAt ? { postedAt: job.postedAt } : {}),
      ...(company?.size ? { companySize: company.size } : {}),
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
      ctx(),
    );
  }

  function countVerdict(patch: JobPatch): void {
    const verdict = patch.set.verdict;
    if (verdict) s3[verdict] += 1;
    if (patch.set.flags?.includes('score_drift')) s3.drift += 1;
  }

  // ---- Re-score: S1 again; reuse stored output where the prompts haven't changed ----
  if (options.rescoreSince) {
    const counts: RescoreCounts = {
      jobs: 0,
      s1Changed: 0,
      recomputed: 0,
      queuedS2: 0,
      queuedS3: 0,
      unchanged: 0,
    };
    rescore = counts;
    // s0 jobs get their first S1 below, and queued jobs are already waiting.
    const recent = (await store.recentJobs(options.rescoreSince, FUNNEL.rescoreMaxJobs)).filter(
      (entry) => entry.job.stage !== 's0' && !entry.job.next,
    );
    counts.jobs = recent.length;
    await loadCompanies(recent);
    const texts = await loadTexts(recent);
    for (const entry of recent) {
      const { job } = entry;
      const result = rules(entry, texts.get(entry.id) ?? '');
      const outcome = s1Outcome(result);
      if (!result.pass) {
        const same = job.skip?.stage === 's1' && job.skip.ruleId === result.ruleId;
        counts[same ? 'unchanged' : 's1Changed'] += 1;
        await write(entry.id, s1SkipPatch(result.ruleId, outcome, ctx()));
        continue;
      }
      if (!job.triage || job.inputs?.s2 !== fingerprints.s2) {
        counts.queuedS2 += 1;
        await write(entry.id, requeuePatch('s2', outcome, deps.now()));
        continue;
      }
      if (!triagePasses(job.triage)) {
        counts.unchanged += 1;
        // Still an S2 skip: restamped under the current criteria version.
        await write(
          entry.id,
          s2SkipPatch({ triage: job.triage, fingerprint: fingerprints.s2, costPence: 0 }, ctx()),
        );
        continue;
      }
      if (!job.deep || job.inputs.s3 !== fingerprints.s3) {
        counts.queuedS3 += 1;
        await write(entry.id, requeuePatch('s3', outcome, deps.now()));
        continue;
      }
      // Same prompts: recompute fit, luck and verdict in code, with the fresh S1 outcome.
      const rejudged: Job = { ...job, flags: outcome.flags, sortAt: outcome.sortAt };
      if (outcome.experienceAsk) rejudged.experienceAsk = outcome.experienceAsk;
      else delete rejudged.experienceAsk;
      const patch = judge(rejudged, job.triage, job.deep, {
        flags: mergeFlags(
          outcome.flags,
          (job.flags ?? []).filter((flag) => DEEP_FLAGS.includes(flag)),
        ),
        costPence: 0,
        s2Fingerprint: fingerprints.s2,
      });
      patch.set.sortAt = outcome.sortAt;
      if (outcome.experienceAsk) patch.set.experienceAsk = outcome.experienceAsk;
      else patch.clear.push('experienceAsk');
      s3.recomputed += 1;
      const changed =
        patch.set.verdict !== job.verdict ||
        patch.set.fitScore !== job.fitScore ||
        patch.set.luckScore !== job.luckScore;
      counts[changed ? 'recomputed' : 'unchanged'] += 1;
      await write(entry.id, patch);
    }
    await flush();
  }

  // ---- S1: free rules on jobs no stage has judged yet ----
  const fresh = await store.s0Jobs(deps.limits.s1MaxJobs);
  const freshTexts = await loadTexts(fresh);
  for (const entry of fresh) {
    s1.in += 1;
    const result = rules(entry, freshTexts.get(entry.id) ?? '');
    if (result.pass) {
      s1.passed += 1;
      await write(entry.id, s1PassPatch(s1Outcome(result)));
      continue;
    }
    s1.skipped += 1;
    if (result.ruleId in s1.byRule || Object.keys(s1.byRule).length < FUNNEL_LIMITS.byRule) {
      s1.byRule[result.ruleId] = (s1.byRule[result.ruleId] ?? 0) + 1;
    }
    await write(entry.id, s1SkipPatch(result.ruleId, s1Outcome(result), ctx()));
  }
  await flush();

  // ---- Expiry sweep: queued jobs past freshness_days leave their queue, free (ADR-043) ----
  // Runs before the lease, so it happens even at the monthly cap or without a profile. The stage
  // reads below only see the newest 300 / best 50, so without this the rest would wait forever.
  const staleBefore = freshnessCutoff(criteria, deps.now());
  for (const stage of QUEUE_STAGES) {
    try {
      const stale = await store.staleQueued(stage, staleBefore, deps.limits.expireMaxJobs);
      for (const entry of stale) {
        // `sortAt` is a stored copy; the rule itself is the one S1 and the stages use.
        if (!isExpired(entry.job, criteria, deps.now())) continue;
        (stage === 's2' ? s2 : s3).expired += 1;
        await write(entry.id, expiredPatch(stage, ctx()));
      }
      await flush();
    } catch (error) {
      // Freeing the queue is housekeeping: a store error here must not stop the stages. Jobs
      // whose writes didn't land stay queued, and the next run sweeps them again.
      log.error('funnel.failed', { step: 'sweep', stage, ...errorFields(error) });
      sweepFailed = true;
    }
  }

  // ---- The run's spend lease (ADR-032) ----
  const month = monthKey(deps.now());
  const leaseId = `run-${options.runId}`;
  let deepAllowed = false;
  if (facts.length === 0) {
    stops.setup = 'no_profile';
  } else {
    const grant = await deps.leases.reserveUpTo({
      month,
      id: leaseId,
      maxPence: deps.limits.runBudgetPence,
      capPence: deps.monthlyCapPence,
      now: deps.now(),
    });
    if (grant.committedPence >= deps.monthlyCapPence * FUNNEL.warnAtFraction) flags.add('spend_80');
    deepAllowed = grant.committedPence < deps.monthlyCapPence * FUNNEL.deepPauseAtFraction;
    if (!deepAllowed) flags.add('deep_pause');
    if (grant.grantedPence <= 0) stops.setup = 'monthly_cap';
    else {
      lease = createRunLease({
        grantedPence: grant.grantedPence,
        s2Share: FUNNEL.s2Share,
        deepAllowed,
      });
    }
  }

  if (lease) {
    await runS2(lease);
    if (deepAllowed) await runS3(lease);
    else stops.s3 = 'deep_pause';
    if (deps.hydrator) {
      await deps.hydrator.finish().catch((error: unknown) => {
        log.error('funnel.failed', { step: 'hydrate_quota', ...errorFields(error) });
      });
    }
    await deps.leases
      .settleLease({ month, id: leaseId, now: deps.now(), settlement: lease.settlement() })
      .catch((error: unknown) => {
        // The lease goes stale and is charged in full: overstated, never understated.
        log.error('funnel.failed', { step: 'settle', ...errorFields(error) });
      });
  }
  return finish();

  // ---- Stages ----

  function llmDeps(activeLease: RunLease, stage: LeaseStage): LlmCallDeps {
    return {
      transport: deps.transport,
      usage: activeLease.usage(stage),
      capPence: activeLease.grantedPence,
      fxUsdToGbp: deps.fxUsdToGbp,
      now: deps.now,
    };
  }

  function pastDeadline(stopMs: number): boolean {
    return deps.clock() - deps.startedAtMs >= stopMs;
  }

  /**
   * Shared error handling for one model call: budget errors stop the stage; unusable output puts
   * the job up for review; anything else (network, API) leaves the job queued, and several in a
   * row stop the stage.
   */
  function stageErrors(stage: QueueStage) {
    let inARow = 0;
    let stopped = false;
    return {
      isStopped() {
        return stopped;
      },
      stop(reason: StopReason) {
        stopped = true;
        stops[stage] ??= reason;
      },
      ok() {
        inARow = 0;
      },
      async handle(error: unknown, jobId: string): Promise<void> {
        if (error instanceof RunBudgetExceededError) {
          this.stop(error.reason === 'deep_pause' ? 'deep_pause' : 'run_budget');
          return;
        }
        if (error instanceof SpendCapExceededError) {
          this.stop('monthly_cap');
          return;
        }
        if (error instanceof LlmOutputError) {
          inARow = 0;
          log.warn('funnel.review', { stage, failure: error.failure });
          (stage === 's2' ? s2 : s3).review += 1;
          await write(jobId, reviewPatch(stage, error.failure, ctx(), error.costPence));
          return;
        }
        log.error('funnel.failed', { step: stage, ...errorFields(error) });
        inARow += 1;
        if (inARow >= MAX_CONSECUTIVE_ERRORS) this.stop('model_errors');
      },
    };
  }

  /**
   * Back-pressure (ADR-039): before a call, waits for in-flight calls to settle until the stage's
   * largest worst case so far fits; a refusal while others are in flight waits for one to settle
   * and retries once. A call that can't fit with nothing in flight stops the stage. Returns
   * undefined when the job was not sent (stage stopped, deadline, or left queued).
   */
  async function withRoom<T>(
    activeLease: RunLease,
    stage: LeaseStage,
    errors: ReturnType<typeof stageErrors>,
    stopMs: number,
    send: () => Promise<T>,
  ): Promise<T | undefined> {
    if (!(await activeLease.waitForRoom(stage))) {
      errors.stop('run_budget');
      return undefined;
    }
    if (errors.isStopped()) return undefined;
    if (pastDeadline(stopMs)) {
      errors.stop('deadline');
      return undefined;
    }
    try {
      return await send();
    } catch (error) {
      const refused = error instanceof RunBudgetExceededError && error.reason === 'run_budget';
      if (!refused || activeLease.inFlight() === 0) throw error;
    }
    await activeLease.nextSettle();
    if (errors.isStopped()) return undefined;
    if (pastDeadline(stopMs)) {
      errors.stop('deadline');
      return undefined;
    }
    try {
      return await send();
    } catch (error) {
      // Still refused with calls in flight: this job waits for the next run, the stage goes on.
      if (
        error instanceof RunBudgetExceededError &&
        error.reason === 'run_budget' &&
        activeLease.inFlight() > 0
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async function runS2(activeLease: RunLease): Promise<void> {
    const began = deps.clock();
    const pacer = createPacer(deps.limits.triageRpm, deps.clock, deps.sleep);
    const queue = await store.queued('s2', deps.limits.s2MaxJobs);
    await loadCompanies(queue);
    const texts = await loadTexts(queue);
    const errors = stageErrors('s2');
    await eachLimited(queue, FUNNEL.s2Concurrency, async (entry) => {
      if (errors.isStopped()) return;
      if (isExpired(entry.job, criteria, deps.now())) {
        s2.expired += 1;
        await write(entry.id, expiredPatch('s2', ctx()));
        return;
      }
      if (pastDeadline(FUNNEL.s2StopMs)) {
        errors.stop('deadline');
        return;
      }
      await pacer.wait();
      if (errors.isStopped()) return;
      try {
        const result = await withRoom(activeLease, 's2', errors, FUNNEL.s2StopMs, () =>
          llmCall(llmDeps(activeLease, 's2'), {
            purpose: 'triage',
            system: systems.s2,
            user: s2User(entry.job, texts.get(entry.id) ?? ''),
            schema: TriageOutputSchema,
          }),
        );
        if (!result) return;
        errors.ok();
        s2.in += 1;
        const triage = result.data;
        const s2Result = { triage, fingerprint: fingerprints.s2, costPence: result.costPence };
        if (!triagePasses(triage)) {
          s2.skipped += 1;
          await write(entry.id, s2SkipPatch(s2Result, ctx()));
          return;
        }
        s2.passed += 1;
        const { job } = entry;
        if (job.deep && job.inputs?.s3 === fingerprints.s3) {
          // Re-score: the triage changed but the deep read's inputs didn't. No S3 call needed.
          s3.recomputed += 1;
          const patch = judge(job, triage, job.deep, {
            flags: (job.flags ?? []).filter((flag) => flag !== 'score_drift'),
            costPence: result.costPence,
            s2Fingerprint: fingerprints.s2,
          });
          countVerdict(patch);
          await write(entry.id, patch);
          return;
        }
        await write(entry.id, s2PassPatch(s2Result, job));
      } catch (error) {
        if (!(error instanceof RunBudgetExceededError || error instanceof SpendCapExceededError)) {
          s2.in += 1;
        }
        await errors.handle(error, entry.id);
      }
    });
    await flush();
    s2.costPence = activeLease.usedPence('s2');
    s2.durationMs = Math.max(0, deps.clock() - began);
  }

  async function runS3(activeLease: RunLease): Promise<void> {
    const began = deps.clock();
    const pacer = createPacer(deps.limits.deepReadRpm, deps.clock, deps.sleep);
    // A few extra, in case some have gone stale while queued.
    const queue = await store.queued('s3', deps.limits.s3MaxJobs * 2);
    await loadCompanies(queue);
    const texts = await loadTexts(queue);
    const errors = stageErrors('s3');
    let started = 0;
    await eachLimited(queue, FUNNEL.s3Concurrency, async (entry) => {
      if (errors.isStopped()) return;
      const { job } = entry;
      if (isExpired(job, criteria, deps.now())) {
        s3.expired += 1;
        await write(entry.id, expiredPatch('s3', ctx()));
        return;
      }
      if (!job.triage) {
        // Not something S2 queues; send it back rather than guess a lane.
        await write(entry.id, { set: { next: 's2' }, clear: [] });
        return;
      }
      if (started >= deps.limits.s3MaxJobs) return;
      if (pastDeadline(FUNNEL.s3StopMs)) {
        errors.stop('deadline');
        return;
      }
      started += 1;
      // Room first: a job that can't be sent keeps its slot and spends no Reed details call.
      if (!(await activeLease.waitForRoom('s3'))) {
        started -= 1;
        errors.stop('run_budget');
        return;
      }
      if (errors.isStopped()) {
        started -= 1;
        return;
      }
      let text = texts.get(entry.id) ?? '';
      const extraFlags: JobFlag[] = (job.flags ?? []).filter(
        (flag) => !DEEP_FLAGS.includes(flag) && flag !== 'score_drift',
      );
      let snippet = job.descriptionKind === 'snippet';
      if (snippet && deps.hydrator) {
        const full = await deps.hydrator.fullText(entry);
        if (full !== null) {
          text = full;
          snippet = false;
        }
      }
      if (snippet) extraFlags.push('snippet_only');
      await pacer.wait();
      if (errors.isStopped()) return;
      try {
        const company = job.companyId ? companyCache.get(job.companyId) : undefined;
        const { triage } = job;
        const result = await withRoom(activeLease, 's3', errors, FUNNEL.s3StopMs, () =>
          llmCall(llmDeps(activeLease, 's3'), {
            purpose: 'deepRead',
            system: systems.s3,
            user: s3User(job, text, {
              lane: triage.lane,
              now: deps.now(),
              descriptionKind: snippet ? 'snippet' : 'full',
              ...(job.postedAt ? { postedAt: job.postedAt } : {}),
              ...(company?.size ? { companySize: company.size } : {}),
              ...(company?.stage ? { companyStage: company.stage } : {}),
            }),
            schema: DeepReadOutputSchema,
            cacheSystem: true,
          }),
        );
        if (!result) {
          // Left queued: the slot goes back (the hydration, if any, is already spent).
          started -= 1;
          return;
        }
        errors.ok();
        s3.in += 1;
        const { deep, downgraded, unknownRefs } = resolveDeepRead(result.data, toId);
        if (downgraded > 0) extraFlags.push('unsupported_match');
        if (downgraded > 0 || unknownRefs > 0) {
          log.warn('funnel.unsupported_match', { downgraded, unknownRefs });
        }
        const patch = judge(job, job.triage, deep, {
          flags: extraFlags,
          costPence: result.costPence,
          s2Fingerprint: job.inputs?.s2 ?? fingerprints.s2,
        });
        countVerdict(patch);
        await write(entry.id, patch);
      } catch (error) {
        if (!(error instanceof RunBudgetExceededError || error instanceof SpendCapExceededError)) {
          s3.in += 1;
        }
        await errors.handle(error, entry.id);
      }
    });
    await flush();
    s3.costPence = activeLease.usedPence('s3');
    s3.durationMs = Math.max(0, deps.clock() - began);
  }

  async function finish(): Promise<FunnelOutcome> {
    await flush();
    const queued = await store.queueCounts().catch((error: unknown) => {
      log.error('funnel.failed', { step: 'queue_counts', ...errorFields(error) });
      return { s2: 0, s3: 0 };
    });
    s2.queued = queued.s2;
    s3.queued = queued.s3;
    if (failedWrites > 0) log.error('funnel.failed', { step: 'write', writes: failedWrites });
    const used = lease?.usedPence() ?? 0;
    // The first reason the model stages stopped: setup, then S3 (the one that matters most), S2.
    const stoppedBy = stops.setup ?? stops.s3 ?? stops.s2;
    return {
      perStage: {
        s1,
        s2,
        hydrate: deps.hydrator?.counts() ?? { attempted: 0, ok: 0, failed: 0 },
        s3,
        ...(rescore ? { rescore } : {}),
      },
      budget: {
        leasePence: lease?.grantedPence ?? 0,
        usedPence: used,
        ...(stoppedBy ? { stoppedBy } : {}),
        ...(stops.s2 || stops.s3
          ? {
              stops: {
                ...(stops.s2 ? { s2: stops.s2 } : {}),
                ...(stops.s3 ? { s3: stops.s3 } : {}),
              },
            }
          : {}),
      },
      flags: [...flags],
      costPence: used,
      summary: {
        s1: { passed: s1.passed, skipped: s1.skipped },
        s2: { passed: s2.passed, skipped: s2.skipped + s2.expired },
        s3: {
          apply: s3.apply,
          near_miss: s3.near_miss,
          wildcard: s3.wildcard,
          skip: s3.skip + s3.expired,
        },
        review: s2.review + s3.review,
        queued,
        costPence: used,
        ...(stoppedBy ? { stoppedBy } : {}),
      },
      failedWrites,
      sweepFailed,
    };
  }
}
