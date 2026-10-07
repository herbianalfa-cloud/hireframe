import { createHash } from 'node:crypto';

import {
  dedupeBatch,
  normaliseCompany,
  normaliseRawJob,
  parseLinkedInAlert,
  planIngest,
  RawJobSchema,
  routeAlert,
  senderDomain,
  type IngestMessage,
  type LockHolder,
  type MessageStatus,
  type NormalisedJob,
  type SourceHealth,
} from '@hireframe/shared';

import { ALERTS, FUNNEL } from '../config.js';
import { DailyCapExceededError, LlmOutputError, SpendCapExceededError } from '../llm/errors.js';
import { errorFields, log } from '../log.js';
import type { ScanStore } from '../scan/run.js';
import { nextEmailHealth, type IngestTally, type SenderDelta } from './health.js';
import type { ModelParser } from './parse-llm.js';

/**
 * One `ingestEmailJobs` request after it has been authenticated (ADR-046, ADR-047): take the scan
 * lock briefly, then for each message in order: skip it if it was handled before, route it by
 * sender, parse it (LinkedIn deterministically, anyone else with the cheap model), normalise →
 * dedupe → plan → write, and record it. New jobs land at `s0`, as from a scan; the next scan's
 * funnel judges them. Nothing from an email (subject, address, link, text) is ever logged or kept
 * beyond the jobs it produced.
 */

export interface AlertMessageRecord {
  sender: string;
  parser: 'deterministic' | 'model';
  jobs: number;
  new: number;
  merged: number;
  duplicate: number;
  unverifiedLinks: number;
  status: 'processed' | 'unparsed';
  at: Date;
  expireAt: Date;
  schemaVersion: 1;
}

export interface IngestStore extends Pick<
  ScanStore,
  'newRunId' | 'acquireLock' | 'releaseLock' | 'findJobsByKeys' | 'writePlan' | 'watchedCompanies'
> {
  /** Which of these message hashes have been handled before. */
  seenMessages(hashes: readonly string[]): Promise<Set<string>>;
  recordMessage(hash: string, record: AlertMessageRecord): Promise<void>;
  readEmailHealth(): Promise<SourceHealth | undefined>;
  writeEmailHealth(health: SourceHealth): Promise<void>;
}

export interface IngestDeps {
  store: IngestStore;
  parseWithModel: ModelParser;
  now: () => Date;
  /** Epoch ms, for the model window. */
  clock: () => number;
}

export type IngestResult =
  | { status: 'busy'; holder?: LockHolder }
  | { status: 'done'; results: { id: string; status: MessageStatus }[] };

export function messageHash(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface MessageOutcome {
  status: MessageStatus;
  parser: 'deterministic' | 'model';
  jobs: number;
  new: number;
  merged: number;
  duplicate: number;
  unverifiedLinks: number;
}

const NONE = { jobs: 0, new: 0, merged: 0, duplicate: 0, unverifiedLinks: 0 } as const;

export async function runIngest(
  deps: IngestDeps,
  messages: readonly IngestMessage[],
): Promise<IngestResult> {
  const { store } = deps;
  const startedAtMs = deps.clock();
  const runId = store.newRunId();
  const lock = await store.acquireLock(runId, deps.now(), 0, 'email');
  if (!lock.ok) {
    log.info('ingest.refused', { reason: 'busy' });
    return {
      status: 'busy',
      ...(lock.reason === 'running' && lock.holder ? { holder: lock.holder } : {}),
    };
  }

  // An ingest that takes over a stale scan lock says so, as a scan does.
  if (lock.recovered) log.warn('scan.recovered', { runId: lock.recovered, code: 'timeout' });
  try {
    log.info('ingest.started', { messages: messages.length });
    const hashes = messages.map((message) => messageHash(message.id));
    const seen = await store.seenMessages(hashes);
    const watched = await store.watchedCompanies();
    const companyIds = new Map(
      watched.map(({ company }) => [normaliseCompany(company.name), company.id]),
    );

    const results: { id: string; status: MessageStatus }[] = [];
    const tally: IngestTally = {
      messages: messages.length,
      jobs: 0,
      new: 0,
      merged: 0,
      duplicate: 0,
      unparsed: 0,
      deferred: 0,
      durationMs: 0,
      bySender: new Map(),
    };
    const senders = new Map<string, SenderDelta>();
    const bump = (domain: string, outcome: MessageOutcome) => {
      const was = senders.get(domain) ?? { messages: 0, jobs: 0, unparsed: 0, unverifiedLinks: 0 };
      senders.set(domain, {
        messages: was.messages + 1,
        jobs: was.jobs + outcome.jobs,
        unparsed: was.unparsed + (outcome.status === 'unparsed' ? 1 : 0),
        unverifiedLinks: was.unverifiedLinks + outcome.unverifiedLinks,
      });
    };

    for (const [index, message] of messages.entries()) {
      const hash = hashes[index] ?? messageHash(message.id);
      if (seen.has(hash)) {
        results.push({ id: message.id, status: 'duplicate' });
        tally.duplicate += 1;
        continue;
      }
      const domain = senderDomain(message.from);
      let outcome: MessageOutcome;
      try {
        outcome = await processMessage(deps, message, companyIds, startedAtMs);
      } catch (error) {
        // Nothing was recorded, so the next trigger retries the message.
        log.error('ingest.failed', { step: 'message', ...errorFields(error) });
        outcome = { status: 'deferred', parser: 'deterministic', ...NONE };
      }
      results.push({ id: message.id, status: outcome.status });
      if (outcome.status === 'deferred') {
        tally.deferred += 1;
        continue;
      }
      tally.jobs += outcome.jobs;
      tally.new += outcome.new;
      tally.merged += outcome.merged;
      tally.duplicate += outcome.duplicate;
      if (outcome.status === 'unparsed') tally.unparsed += 1;
      bump(domain, outcome);
      const at = deps.now();
      await store.recordMessage(hash, {
        sender: domain,
        parser: outcome.parser,
        jobs: outcome.jobs,
        new: outcome.new,
        merged: outcome.merged,
        duplicate: outcome.duplicate,
        unverifiedLinks: outcome.unverifiedLinks,
        status: outcome.status === 'unparsed' ? 'unparsed' : 'processed',
        at,
        expireAt: new Date(at.getTime() + ALERTS.messageTtlDays * DAY_MS),
        schemaVersion: 1,
      });
      log.info('ingest.message', {
        parser: outcome.parser,
        status: outcome.status,
        jobs: outcome.jobs,
        new: outcome.new,
        merged: outcome.merged,
        duplicate: outcome.duplicate,
      });
    }

    tally.durationMs = Math.max(0, deps.clock() - startedAtMs);
    const health = nextEmailHealth(
      await store.readEmailHealth().catch(() => undefined),
      { ...tally, bySender: senders },
      deps.now(),
    );
    await store.writeEmailHealth(health).catch((error: unknown) => {
      log.error('ingest.failed', { step: 'health', ...errorFields(error) });
    });
    log.info('ingest.done', {
      messages: tally.messages,
      jobs: tally.jobs,
      new: tally.new,
      merged: tally.merged,
      duplicate: tally.duplicate,
      unparsed: tally.unparsed,
      deferred: tally.deferred,
    });
    return { status: 'done', results };
  } finally {
    await store.releaseLock(runId, deps.now()).catch((error: unknown) => {
      log.error('ingest.failed', { step: 'unlock', ...errorFields(error) });
    });
  }
}

async function processMessage(
  deps: IngestDeps,
  message: IngestMessage,
  companyIds: ReadonlyMap<string, string>,
  startedAtMs: number,
): Promise<MessageOutcome> {
  const { store } = deps;
  const deterministic = routeAlert(message.from) === 'linkedin';
  let raws: unknown[];
  let unverifiedLinks = 0;

  if (deterministic) {
    const parsed = parseLinkedInAlert({ text: message.text, html: message.html });
    // Job links but no parsed card: a layout change. Counted, relabelled, never guessed.
    if (parsed.jobs.length === 0 && parsed.jobLinks > 0) {
      return { status: 'unparsed', parser: 'deterministic', ...NONE };
    }
    raws = parsed.jobs;
  } else {
    // UrlFetchApp gives up at about 60 s: later messages wait for the next trigger.
    if (deps.clock() - startedAtMs > ALERTS.modelWindowMs) {
      return { status: 'deferred', parser: 'model', ...NONE };
    }
    try {
      const parsed = await deps.parseWithModel(message);
      raws = parsed.jobs;
      unverifiedLinks = parsed.unverifiedLinks;
    } catch (error) {
      // Over a cap, or the service failed: try again later. Bad output twice, a refusal or
      // max_tokens: unparsed, never guessed.
      if (error instanceof LlmOutputError) {
        log.warn('ingest.parse_failed', { failure: error.failure });
        return { status: 'unparsed', parser: 'model', ...NONE };
      }
      if (error instanceof DailyCapExceededError || error instanceof SpendCapExceededError) {
        log.info('ingest.refused', { reason: 'cap' });
      } else {
        log.error('ingest.parse_failed', { failure: 'error', ...errorFields(error) });
      }
      return { status: 'deferred', parser: 'model', ...NONE };
    }
  }

  const normalised: NormalisedJob[] = [];
  for (const candidate of raws) {
    const raw = RawJobSchema.safeParse(candidate);
    if (!raw.success) continue;
    const companyId = raw.data.companyId ?? companyIds.get(normaliseCompany(raw.data.company));
    const job = normaliseRawJob({ ...raw.data, ...(companyId ? { companyId } : {}) });
    if (job) normalised.push(job);
  }
  const parser = deterministic ? 'deterministic' : 'model';
  if (normalised.length === 0) return { status: 'processed', parser, ...NONE, unverifiedLinks };

  const groups = dedupeBatch(normalised);
  const existing = await store.findJobsByKeys([...new Set(groups.flatMap((group) => group.keys))]);
  const plan = planIngest(groups, existing, { minUpgradeChars: FUNNEL.minDeepReadChars });
  if (plan.counts.conflicts > 0) log.warn('dedupe.conflict', { count: plan.counts.conflicts });
  const { failedWrites } = await store.writePlan(plan, deps.now());
  // A failed write must not mark the message done: a retry finds what landed and adds the rest.
  if (failedWrites > 0) return { status: 'deferred', parser, ...NONE };
  return {
    status: 'processed',
    parser,
    jobs: normalised.length,
    new: plan.counts.new,
    merged: plan.counts.merged,
    duplicate: plan.counts.duplicate,
    unverifiedLinks,
  };
}
