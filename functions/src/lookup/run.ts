import {
  alertExternalId,
  ageToPostedAt,
  buildNewJob,
  canonicalLinkedInJobUrl,
  dedupeBatch,
  normaliseRawJob,
  parseAtsUrl,
  PATHS,
  RawJobSchema,
  searchLinkFor,
  triagePasses,
  type BatchGroup,
  type CriteriaVersion,
  type Job,
  type JobDescription,
  type LockHolder,
  type LookupAddResult,
  type LookupDescribeResult,
  type LookupJobInput,
  type LookupOutcome,
  type LookupQueueReason,
  type NormalisedJob,
  type RawJob,
  type S1Result,
  type ReviewCode,
} from '@hireframe/shared';

import { LOOKUP } from '../config.js';
import { planAttachment } from '../funnel/attach.js';
import {
  applyPatch,
  mergeFlags,
  needsDescriptionPatch,
  reviewPatch,
  s1PassPatch,
  s1SkipPatch,
  s2PassPatch,
  s2SkipPatch,
  type JobPatch,
  type JudgeContext,
  type S1Outcome,
} from '../funnel/judgement.js';
import type { CompanyInfo, FunnelStore } from '../funnel/run.js';
import { buildFunnelContext, type FunnelContext } from '../funnel/steps.js';
import type { LlmCallDeps } from '../llm/call.js';
import { DailyCapExceededError, LlmOutputError, SpendCapExceededError } from '../llm/errors.js';
import { log } from '../log.js';
import type { ScanStore } from '../scan/run.js';
import { eachLimited } from '../sources/types.js';
import type { AtsSearch } from './ats-search.js';
import type { JobChange, LookupStore, Precondition } from './store.js';

/**
 * The `lookup` callable's work (ADR-049), dependency-injected like `runScan` and `runIngest`.
 *
 * `add` creates the jobs the owner chose (under the scan lock, for the create step only), runs S1
 * at once, then S2 on title, company and location, then the ATS board search for a full posting,
 * then S3 when there is text. Model calls run outside the lock, under the monthly cap and the
 * daily Lookup cap, and every write after one is a precondition transaction: if a scan moved the
 * job meanwhile, Lookup's write is dropped and counted. A cap, the clock or an error never fails
 * the call: the job is left queued for the next scan, which reads user-added jobs first.
 *
 * `describe` judges a job from a description the owner pasted. Job text is untrusted: it only ever
 * reaches the model through the funnel's prompts, which wrap it as data.
 */

export class LookupUnavailableError extends Error {
  override name = 'LookupUnavailableError';
  readonly reason: 'no_criteria';
  constructor(reason: 'no_criteria') {
    super(`Lookup unavailable: ${reason}`);
    this.reason = reason;
  }
}

export interface LookupDeps {
  scan: Pick<ScanStore, 'newRunId' | 'acquireLock' | 'releaseLock' | 'findJobsByKeys'>;
  store: LookupStore;
  funnel: Pick<FunnelStore, 'loadProfile' | 'companies'>;
  readCriteria: () => Promise<CriteriaVersion | null>;
  /** The model: monthly cap, the daily Lookup cap on its usage store, reservation IDs `lookup-…`. */
  llm: LlmCallDeps;
  ats: AtsSearch;
  now: () => Date;
  /** Epoch ms. */
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  /** When the call started (epoch ms); no model call starts after `LOOKUP.deadlineMs`. */
  startedAtMs: number;
}

// ---- Shared helpers ----

const MIN_TEXT = 200;

function s1Outcome(result: S1Result, estimated: boolean): S1Outcome {
  return {
    flags: estimated ? mergeFlags(result.flags, ['posted_estimated']) : result.flags,
    sortAt: result.sortAt,
    ...(result.experienceAsk ? { experienceAsk: result.experienceAsk } : {}),
  };
}

/** What a model call came to, with caps and failures sorted into the ways Lookup reacts to them. */
type Guarded<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'cap'; cap: 'daily' | 'monthly' }
  | { kind: 'review'; code: ReviewCode; costPence: number }
  | { kind: 'error' };

async function guarded<T>(call: () => Promise<T>): Promise<Guarded<T>> {
  try {
    return { kind: 'ok', value: await call() };
  } catch (error) {
    if (error instanceof DailyCapExceededError) return { kind: 'cap', cap: 'daily' };
    if (error instanceof SpendCapExceededError) return { kind: 'cap', cap: 'monthly' };
    if (error instanceof LlmOutputError) {
      return { kind: 'review', code: error.failure, costPence: error.costPence };
    }
    log.error('lookup.failed', {
      step: 'model',
      kind: error instanceof Error ? error.name : 'other',
    });
    return { kind: 'error' };
  }
}

const QUEUE_REASON = { daily: 'daily_cap', monthly: 'monthly_cap' } as const;

async function waitForLock(deps: LookupDeps, runId: string): Promise<LockHolder | null> {
  const began = deps.clock();
  for (;;) {
    const result = await deps.scan.acquireLock(runId, deps.now(), 0, 'lookup');
    if (result.ok) return null;
    const holder = result.reason === 'running' ? (result.holder ?? 'scan') : 'scan';
    if (deps.clock() - began + LOOKUP.lockPollMs > LOOKUP.lockWaitMs) return holder;
    await deps.sleep(LOOKUP.lockPollMs);
  }
}

async function loadCompany(
  deps: LookupDeps,
  cache: Map<string, CompanyInfo>,
  companyId: string | undefined,
): Promise<CompanyInfo | undefined> {
  if (!companyId) return undefined;
  if (!cache.has(companyId)) {
    const found = await deps.funnel.companies([companyId]);
    cache.set(companyId, found.get(companyId) ?? {});
  }
  return cache.get(companyId);
}

// ---- add ----

interface Prepared {
  index: number;
  job: NormalisedJob;
  estimated: boolean;
}

/** The raw job a pasted row or a board posting becomes (source `lookup`, ADR-049). */
function rawFromInput(input: LookupJobInput, posting: NormalisedJob | null, now: Date): RawJob {
  if (input.kind === 'url' && posting) {
    return {
      sourceId: 'lookup',
      externalId: posting.externalId,
      url: posting.url,
      title: posting.title,
      company: posting.company,
      ...(posting.companyId ? { companyId: posting.companyId } : {}),
      locationText: posting.location,
      ...(posting.remote === 'unknown' ? {} : { remoteHint: posting.remote }),
      description: { kind: 'full', format: 'text', body: posting.description.text },
      ...(posting.postedAt ? { postedAt: posting.postedAt } : {}),
      ...(posting.salary ? { salary: posting.salary } : {}),
    };
  }
  if (input.kind !== 'row') throw new Error('a URL input needs its posting');
  const postedAt = input.age ? ageToPostedAt(input.age, now) : undefined;
  return {
    sourceId: 'lookup',
    // The LinkedIn ID when known, else a hash of company|title|city (no link needed).
    externalId: input.linkedinId ?? alertExternalId(input.company, input.title, input.location),
    // With neither a posting URL nor an ID, a search link the owner can click; never fetched.
    url: input.linkedinId
      ? canonicalLinkedInJobUrl(input.linkedinId)
      : searchLinkFor(input.title, input.company),
    ...(input.linkedinId ? {} : { searchLink: true as const }),
    title: input.title,
    company: input.company,
    locationText: input.location,
    description: { kind: 'none', format: 'text', body: '' },
    ...(postedAt ? { postedAt } : {}),
  };
}

interface Survivor {
  id: string;
  job: Job;
  text: string;
  indexes: number[];
}

export async function runAdd(
  deps: LookupDeps,
  inputs: readonly LookupJobInput[],
): Promise<LookupAddResult> {
  const criteria = await deps.readCriteria();
  if (!criteria) throw new LookupUnavailableError('no_criteria');
  const now = deps.now();
  const ctx: JudgeContext = { criteriaVersion: criteria.version, now };
  const outcomes: (LookupOutcome | undefined)[] = inputs.map(() => undefined);
  const { facts, workRights } = await deps.funnel.loadProfile();
  const steps = buildFunnelContext(criteria, facts, workRights);

  // 1. Every input becomes a normalised job, or an outcome saying why not.
  const prepared: Prepared[] = [];
  for (const [index, input] of inputs.entries()) {
    let posting: NormalisedJob | null = null;
    if (input.kind === 'url') {
      const target = parseAtsUrl(input.url);
      const found = target ? await deps.ats.fetchPosting(target) : null;
      if (!found) {
        outcomes[index] = { status: 'not_found' };
        continue;
      }
      posting = found.posting;
    }
    const raw = RawJobSchema.safeParse(rawFromInput(input, posting, now));
    const job = raw.success ? normaliseRawJob(raw.data) : null;
    if (!job) {
      outcomes[index] = { status: 'invalid' };
      continue;
    }
    prepared.push({
      index,
      job,
      estimated: input.kind === 'row' && job.postedAt !== undefined,
    });
  }

  // 2. Create the new ones, under the lock for this step only.
  const groups = dedupeBatch(prepared.map((item) => item.job));
  const memberOf = new Map<NormalisedJob, Prepared>(prepared.map((item) => [item.job, item]));
  const survivors: Survivor[] = [];
  const runId = `lookup-${deps.scan.newRunId()}`;
  const busyHolder = groups.length > 0 ? await waitForLock(deps, runId) : null;
  if (busyHolder) {
    log.warn('lookup.busy', { holder: busyHolder });
    return { status: 'busy', retryAfterSeconds: LOOKUP.busyRetrySeconds[busyHolder] };
  }
  if (groups.length > 0) {
    try {
      const existing = await deps.scan.findJobsByKeys(groups.flatMap((group) => group.keys));
      const creates: { group: BatchGroup; id: string; job: Job; text: string }[] = [];
      for (const group of groups) {
        const keys = new Set(group.keys);
        const target = existing
          .filter((job) => job.keys.some((key) => keys.has(key)))
          .sort(
            (a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime() || a.id.localeCompare(b.id),
          )[0];
        if (target) {
          // A seen job is never re-created.
          for (const member of group.jobs) {
            const item = memberOf.get(member);
            if (item) outcomes[item.index] = { status: 'seen', jobId: target.id };
          }
          continue;
        }
        const id = deps.store.newJobId();
        const { job } = buildNewJob(group, PATHS.jobDescription(id), now);
        const primary = group.jobs[0];
        const text = primary?.description.kind === 'full' ? primary.description.text : '';
        // S1 runs on what we have now; the stamp is final for a skip.
        const estimated = group.jobs.some((member) => memberOf.get(member)?.estimated);
        const result = steps.rules(job, text, now);
        const outcome = s1Outcome(result, estimated);
        const patch = result.pass ? s1PassPatch(outcome) : s1SkipPatch(result.ruleId, outcome, ctx);
        creates.push({
          group,
          id,
          job: applyPatch({ ...job, addedAt: now }, patch, now),
          text,
        });
        if (!result.pass) {
          for (const member of group.jobs) {
            const item = memberOf.get(member);
            if (item) {
              outcomes[item.index] = {
                status: 'skipped',
                jobId: id,
                stage: 's1',
                ruleId: result.ruleId,
              };
            }
          }
        }
      }
      const items = creates.map(({ id, job, group }) => {
        const [primary] = group.jobs;
        const full = group.jobs.find((member) => member.description.kind === 'full') ?? primary;
        const description: JobDescription = {
          text: full?.description.text ?? '',
          kind: full?.description.kind ?? 'none',
          sourceId: full?.sourceId ?? 'lookup',
          fetchedAt: now,
          schemaVersion: 1,
        };
        return { id, job, description };
      });
      const failed = new Set(await deps.store.createJobs(items));
      if (failed.size > 0) log.error('lookup.failed', { step: 'create', writes: failed.size });
      for (const created of creates) {
        const indexes = created.group.jobs.flatMap((member) => memberOf.get(member)?.index ?? []);
        if (failed.has(created.id)) {
          // Nothing was written, so there is no job to report or judge.
          for (const index of indexes) outcomes[index] = { status: 'invalid' };
          continue;
        }
        if (created.job.verdict === 'skip') continue;
        survivors.push({ id: created.id, job: created.job, text: created.text, indexes });
      }
    } finally {
      await deps.scan.releaseLock(runId, deps.now()).catch(() => {
        log.error('lookup.failed', { step: 'release' });
      });
    }
  }

  // 3. S2, the board search and S3, outside the lock.
  const summary = await judgeSurvivors(deps, steps, facts.length, survivors, outcomes, ctx);
  const done = outcomes.map((outcome): LookupOutcome => outcome ?? { status: 'invalid' });
  log.info('lookup.done', {
    action: 'add',
    jobs: inputs.length,
    judged: done.filter((o) => o.status === 'judged').length,
    skipped: done.filter((o) => o.status === 'skipped').length,
    needsDescription: done.filter((o) => o.status === 'needs_description').length,
    queued: done.filter((o) => o.status === 'queued').length,
    seen: done.filter((o) => o.status === 'seen').length,
    dropped: summary.dropped,
    capReached: summary.capReached ?? 'none',
  });
  return { status: 'done', outcomes: done, capReached: summary.capReached };
}

interface JudgeSummary {
  capReached: 'daily' | 'monthly' | null;
  dropped: number;
}

async function judgeSurvivors(
  deps: LookupDeps,
  steps: FunnelContext,
  factCount: number,
  survivors: readonly Survivor[],
  outcomes: (LookupOutcome | undefined)[],
  ctx: JudgeContext,
): Promise<JudgeSummary> {
  const summary: JudgeSummary = { capReached: null, dropped: 0 };
  const setOutcome = (item: Survivor, outcome: LookupOutcome) => {
    for (const index of item.indexes) outcomes[index] = outcome;
  };
  if (survivors.length === 0) return summary;

  // Nothing to compare a job with: leave them queued for the scan that has a profile.
  if (factCount === 0) {
    for (const item of survivors) setOutcome(item, queued(item, 'no_profile'));
    return summary;
  }

  const companies = new Map<string, CompanyInfo>();
  let stop: LookupQueueReason | null = null;
  let errorsInARow = 0;
  const timeUp = () => deps.clock() - deps.startedAtMs >= LOOKUP.deadlineMs;
  const mayCall = (): LookupQueueReason | null => stop ?? (timeUp() ? 'time' : null);
  const noteStop = (result: Guarded<unknown>): void => {
    if (result.kind === 'cap') {
      summary.capReached ??= result.cap;
      stop ??= QUEUE_REASON[result.cap];
    }
    errorsInARow = result.kind === 'error' ? errorsInARow + 1 : 0;
    if (errorsInARow >= 3) stop ??= 'error';
  };
  const commit = async (item: Survivor, pre: Precondition, change: JobChange): Promise<boolean> => {
    const result = await deps.store.commit(item.id, pre, change, deps.now());
    if (result === 'applied') return true;
    // A scan (or re-score) moved the job while the model ran: its judgement stands.
    summary.dropped += 1;
    log.warn('lookup.dropped', { result });
    setOutcome(item, { status: 'seen', jobId: item.id });
    return false;
  };

  const deepQueue: { item: Survivor; job: Job; triage: Job['triage']; text: string }[] = [];

  // S2 on title, company and location (and the posting's text, for a board URL).
  await eachLimited(survivors, LOOKUP.s2Concurrency, async (item) => {
    const blocked = mayCall();
    if (blocked) {
      setOutcome(item, queued(item, blocked));
      return;
    }
    const pre: Precondition = { stage: 's1', next: 's2' };
    const result = await guarded(() => steps.triage(deps.llm, item.job, item.text));
    noteStop(result);
    if (result.kind === 'cap') {
      setOutcome(item, queued(item, QUEUE_REASON[result.cap]));
      return;
    }
    if (result.kind === 'error') {
      setOutcome(item, queued(item, 'error'));
      return;
    }
    if (result.kind === 'review') {
      const patch = reviewPatch('s2', result.code, ctx, result.costPence);
      if (await commit(item, pre, { patch }))
        setOutcome(item, { status: 'review', jobId: item.id });
      return;
    }
    const triage = result.value.data;
    const s2Result = {
      triage,
      fingerprint: steps.fingerprints.s2,
      costPence: result.value.costPence,
    };
    if (!triagePasses(triage)) {
      if (!(await commit(item, pre, { patch: s2SkipPatch(s2Result, ctx) }))) return;
      setOutcome(item, {
        status: 'skipped',
        jobId: item.id,
        stage: 's2',
        ...(triage.note ? { note: triage.note } : {}),
      });
      return;
    }

    // Passed: look for the full posting on the company's board (a URL job already has it).
    const pass = s2PassPatch(s2Result, item.job);
    let text = item.text;
    let change: JobChange = { patch: pass };
    if (text.length < MIN_TEXT) {
      const found = await deps.ats.find({
        title: item.job.title,
        company: item.job.company,
        city: item.job.city,
        ...(item.job.companyId ? { companyId: item.job.companyId } : {}),
      });
      const match = found.match;
      if (match && match.posting.description.text.length >= MIN_TEXT) {
        text = match.posting.description.text;
        change = {
          patch: pass,
          attach: planAttachment(item.job, match.posting, deps.now()),
          ...(match.companyId && !item.job.companyId ? { companyId: match.companyId } : {}),
        };
      }
    }
    if (text.length < MIN_TEXT) {
      // Nothing to read: wait for a description (free, like S3's own routing, ADR-048).
      const waiting = needsDescriptionPatch(item.job);
      const patch: JobPatch = {
        set: { ...pass.set, ...waiting.set },
        clear: [...pass.clear, ...waiting.clear],
        ...(pass.addCostPence ? { addCostPence: pass.addCostPence } : {}),
      };
      if (await commit(item, pre, { patch })) {
        setOutcome(item, { status: 'needs_description', jobId: item.id });
      }
      return;
    }
    if (!(await commit(item, pre, change))) return;
    deepQueue.push({
      item,
      job: {
        ...applyPatch(item.job, pass, deps.now()),
        descriptionKind: 'full',
        ...(change.companyId ? { companyId: change.companyId } : {}),
        ...(change.attach?.postedAt ? { postedAt: change.attach.postedAt } : {}),
      },
      triage,
      text,
    });
  });

  // S3 on the ones with text.
  await eachLimited(deepQueue, LOOKUP.s3Concurrency, async ({ item, job, triage, text }) => {
    if (!triage) return;
    const blocked = mayCall();
    if (blocked) {
      setOutcome(item, queued(item, blocked));
      return;
    }
    const pre: Precondition = { stage: 's2', next: 's3' };
    const company = await loadCompany(deps, companies, job.companyId);
    const result = await guarded(() =>
      steps.deepRead(deps.llm, job, triage, {
        text,
        descriptionKind: 'full',
        now: deps.now(),
        cacheSystem: false,
        ...(company ? { company } : {}),
      }),
    );
    noteStop(result);
    if (result.kind === 'cap') {
      setOutcome(item, queued(item, QUEUE_REASON[result.cap]));
      return;
    }
    if (result.kind === 'error') {
      setOutcome(item, queued(item, 'error'));
      return;
    }
    if (result.kind === 'review') {
      const patch = reviewPatch('s3', result.code, ctx, result.costPence);
      if (await commit(item, pre, { patch }))
        setOutcome(item, { status: 'review', jobId: item.id });
      return;
    }
    const { deep, downgraded, costPence } = result.value;
    const patch = steps.judge(
      job,
      triage,
      deep,
      {
        flags: mergeFlags(
          (job.flags ?? []).filter((flag) => flag === 'posted_estimated'),
          downgraded > 0 ? ['unsupported_match'] : [],
        ),
        costPence,
        s2Fingerprint: job.inputs?.s2 ?? steps.fingerprints.s2,
        now: deps.now(),
        ...(company ? { company } : {}),
      },
      ctx,
    );
    if (!(await commit(item, pre, { patch }))) return;
    const verdict = patch.set.verdict;
    if (verdict) setOutcome(item, { status: 'judged', jobId: item.id, verdict });
  });

  return summary;
}

function queued(item: Survivor, reason: LookupQueueReason): LookupOutcome {
  return { status: 'queued', jobId: item.id, reason };
}

// ---- describe ----

export async function runDescribe(
  deps: LookupDeps,
  jobId: string,
  rawText: string,
): Promise<LookupDescribeResult> {
  const criteria = await deps.readCriteria();
  if (!criteria) throw new LookupUnavailableError('no_criteria');
  const now = deps.now();
  const ctx: JudgeContext = { criteriaVersion: criteria.version, now };
  const text = rawText.trim();

  // The claim: `next: 'description'` → null, so a scan can't pick the job up while it is judged.
  const claimed = await deps.store.claimDescription(jobId, now, LOOKUP.describeClaimStaleMs);
  if (!claimed) return { status: 'refused' };
  const description: JobDescription = {
    text,
    kind: 'full',
    sourceId: 'lookup',
    fetchedAt: now,
    schemaVersion: 1,
  };
  await deps.store.saveDescription(jobId, description, now);

  let job: Job = { ...claimed, descriptionKind: 'full' };
  const pre = (): Precondition => ({
    stage: job.stage,
    next: null,
    ...(job.judgedAt ? { judgedAt: job.judgedAt } : {}),
    describingAt: now,
  });
  const release = { describingAt: 'clear' } as const;
  const refused = (): LookupDescribeResult => {
    log.warn('lookup.dropped', { result: 'describe' });
    return { status: 'refused' };
  };

  const { facts, workRights } = await deps.funnel.loadProfile();
  const steps = buildFunnelContext(criteria, facts, workRights);

  // S1 again, now that there is text (clearance, right-to-work and experience rules need it).
  const estimated = job.flags?.includes('posted_estimated') ?? false;
  const s1 = steps.rules(job, text, now);
  const outcome = s1Outcome(s1, estimated);
  if (!s1.pass) {
    const patch = s1SkipPatch(s1.ruleId, outcome, ctx);
    if ((await deps.store.commit(jobId, pre(), { patch, ...release }, now)) !== 'applied') {
      return refused();
    }
    return { status: 'skipped', stage: 's1', ruleId: s1.ruleId };
  }
  // S1's fields ride along on every later write; `needs_description` leaves with the flags.
  const base = (patch: JobPatch): JobPatch => ({
    ...patch,
    set: {
      ...patch.set,
      sortAt: outcome.sortAt,
      ...(outcome.experienceAsk ? { experienceAsk: outcome.experienceAsk } : {}),
    },
    clear: outcome.experienceAsk ? patch.clear : [...patch.clear, 'experienceAsk'],
  });
  const baseFlags = outcome.flags;

  /** A cap or error: the text is saved, and the next scan judges the job (user-added first). */
  const fallback = async (reason: LookupQueueReason): Promise<LookupDescribeResult> => {
    const patch = base({
      set: { next: job.triage ? 's3' : 's2', flags: baseFlags },
      clear: [],
    });
    if ((await deps.store.commit(jobId, pre(), { patch, ...release }, now)) !== 'applied') {
      return refused();
    }
    return { status: 'queued', reason };
  };

  if (facts.length === 0) return fallback('no_profile');

  // S2 first, if the job has no triage yet.
  if (!job.triage) {
    const result = await guarded(() => steps.triage(deps.llm, job, text));
    if (result.kind === 'cap') return fallback(QUEUE_REASON[result.cap]);
    if (result.kind === 'error') return fallback('error');
    if (result.kind === 'review') {
      const patch = reviewPatch('s2', result.code, ctx, result.costPence);
      if ((await deps.store.commit(jobId, pre(), { patch, ...release }, now)) !== 'applied') {
        return refused();
      }
      return { status: 'review' };
    }
    const triage = result.value.data;
    const s2Result = {
      triage,
      fingerprint: steps.fingerprints.s2,
      costPence: result.value.costPence,
    };
    if (!triagePasses(triage)) {
      const patch = base(s2SkipPatch(s2Result, ctx));
      if ((await deps.store.commit(jobId, pre(), { patch, ...release }, now)) !== 'applied') {
        return refused();
      }
      return {
        status: 'skipped',
        stage: 's2',
        ...(triage.note ? { note: triage.note } : {}),
      };
    }
    // Kept out of the queue (next null) while this call still holds the job.
    const pass = s2PassPatch(s2Result, job);
    const patch = base({ ...pass, set: { ...pass.set, next: null, flags: baseFlags } });
    if ((await deps.store.commit(jobId, pre(), { patch }, now)) !== 'applied') return refused();
    job = applyPatch(job, patch, now);
  }

  const { triage } = job;
  if (!triage) return fallback('error');
  const companies = new Map<string, CompanyInfo>();
  const company = await loadCompany(deps, companies, job.companyId);
  const deep = await guarded(() =>
    steps.deepRead(deps.llm, job, triage, {
      text,
      descriptionKind: 'full',
      now: deps.now(),
      cacheSystem: false,
      ...(company ? { company } : {}),
    }),
  );
  if (deep.kind === 'cap') return fallback(QUEUE_REASON[deep.cap]);
  if (deep.kind === 'error') return fallback('error');
  if (deep.kind === 'review') {
    const patch = reviewPatch('s3', deep.code, ctx, deep.costPence);
    if ((await deps.store.commit(jobId, pre(), { patch, ...release }, now)) !== 'applied') {
      return refused();
    }
    return { status: 'review' };
  }
  const judged = steps.judge(
    job,
    triage,
    deep.value.deep,
    {
      flags: mergeFlags(baseFlags, deep.value.downgraded > 0 ? ['unsupported_match'] : []),
      costPence: deep.value.costPence,
      s2Fingerprint: job.inputs?.s2 ?? steps.fingerprints.s2,
      now: deps.now(),
      ...(company ? { company } : {}),
    },
    ctx,
  );
  const patch = base(judged);
  if ((await deps.store.commit(jobId, pre(), { patch, ...release }, now)) !== 'applied') {
    return refused();
  }
  const verdict = patch.set.verdict;
  if (!verdict) return fallback('error');
  log.info('lookup.done', { action: 'describe', verdict });
  return { status: 'judged', verdict };
}
