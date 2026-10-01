import {
  BROKEN_BOARD_AFTER,
  dedupeBatch,
  normaliseRawJob,
  planIngest,
  RawJobSchema,
  SCAN_SOURCE_IDS,
  type Company,
  type CompanySeed,
  type CriteriaContent,
  type ExistingJobKeys,
  type IngestPlan,
  type NormalisedJob,
  type Quota,
  type Run,
  type RunStatus,
  type S0Counts,
  type ScanNowResult,
  type ScanSourceId,
  type SourceHealth,
  type SourceRunCounts,
} from '@hireframe/shared';

import { QUOTAS, SCAN } from '../config.js';
import type { HttpClient } from '../http/client.js';
import { errorFields, log } from '../log.js';
import { addCalls, currentQuota, remainingCalls } from '../sources/queries.js';
import type {
  BoardResult,
  Source,
  SourceReport,
  SourceSecrets,
  WatchedCompany,
} from '../sources/types.js';

/**
 * One ingest run (ADR-029): lock → seed companies → fetch every source in parallel → validate,
 * normalise and dedupe (ADR-030) → write new jobs at stage `s0` and new sources on known jobs →
 * company, source and run records → unlock. A failing source never fails the run (PRD R4).
 * M3 runs it from `scanNow` only; M4 adds the funnel after it and the schedule.
 */

export type LockResult =
  | { ok: true }
  | { ok: false; reason: 'running' }
  | { ok: false; reason: 'recent'; lastFinishedAt: Date };

export interface StoredCompany {
  company: WatchedCompany;
  lastScan?: Company['lastScan'];
}

export interface ScanStore {
  newRunId(): string;
  acquireLock(runId: string, now: Date, cooldownMs: number): Promise<LockResult>;
  releaseLock(runId: string, now: Date): Promise<void>;
  createRun(runId: string, run: Run): Promise<void>;
  finishRun(runId: string, run: Run): Promise<void>;
  /** Creates seed companies that don't exist yet; returns how many it created. */
  ensureSeedCompanies(seed: readonly CompanySeed[], now: Date): Promise<number>;
  watchedCompanies(): Promise<StoredCompany[]>;
  sourceStates(): Promise<Partial<Record<ScanSourceId, SourceHealth>>>;
  findJobsByKeys(keys: readonly string[]): Promise<ExistingJobKeys[]>;
  /** Returns the writes that failed (their batches are logged and skipped). */
  writePlan(plan: IngestPlan, now: Date): Promise<{ failedWrites: number }>;
  updateCompanies(
    updates: { companyId: string; lastScan: NonNullable<Company['lastScan']> }[],
    now: Date,
  ): Promise<void>;
  writeSourceHealth(states: Partial<Record<ScanSourceId, SourceHealth>>): Promise<void>;
}

export interface ScanDeps {
  store: ScanStore;
  readCriteria: () => Promise<CriteriaContent | null>;
  createSources: () => Record<ScanSourceId, Source>;
  /** A fresh client for one source, stopping at `deadline` (epoch ms). */
  httpFor: (deadline: number) => HttpClient;
  secrets: SourceSecrets;
  seed: readonly CompanySeed[];
  disabledSources: readonly string[];
  cooldownMs: number;
  trigger: Run['trigger'];
  now: () => Date;
}

export type ScanResult = ScanNowResult | { status: 'busy' };

const QUOTA_SOURCES: Partial<Record<ScanSourceId, keyof typeof QUOTAS>> = {
  reed: 'reed',
  adzuna: 'adzuna',
};

const ATS_SOURCES = new Set<ScanSourceId>(['greenhouse', 'lever', 'ashby', 'workable']);

interface SourceOutcome {
  report: SourceReport;
  jobs: unknown[];
  requests: number;
  durationMs: number;
  quota?: Quota;
}

/** What one board's result does to its company's `lastScan` (pure). */
export function companyScanUpdate(
  previous: Company['lastScan'],
  board: BoardResult,
): NonNullable<Company['lastScan']> {
  const failures = board.status === 'ok' ? 0 : (previous?.consecutiveFailures ?? 0) + 1;
  return {
    status: board.status,
    jobs: board.jobs,
    consecutiveFailures: failures,
    broken: board.status === 'not_found' && failures >= BROKEN_BOARD_AFTER,
    ...(board.errorCode ? { errorCode: board.errorCode } : {}),
  };
}

/** The new `sources/{id}` record after a run (pure). */
export function nextSourceHealth(
  previous: SourceHealth | undefined,
  counts: SourceRunCounts,
  now: Date,
  extras: { quota?: Quota; queryCursor?: number },
): SourceHealth {
  const failed = counts.status === 'failing';
  const lastOkAt =
    counts.status === 'ok' || counts.status === 'degraded' ? now : previous?.lastOkAt;
  return {
    status: counts.status,
    lastRunAt: now,
    ...(lastOkAt ? { lastOkAt } : {}),
    consecutiveFailures: failed ? (previous?.consecutiveFailures ?? 0) + 1 : 0,
    ...(counts.errorCode ? { lastErrorCode: counts.errorCode } : {}),
    lastCounts: counts,
    ...(extras.quota ? { quota: extras.quota } : {}),
    ...(extras.queryCursor === undefined
      ? previous?.queryCursor === undefined
        ? {}
        : { queryCursor: previous.queryCursor }
      : { queryCursor: extras.queryCursor }),
    updatedAt: now,
    schemaVersion: 1,
  };
}

/** succeeded: every enabled source fine. failed: nothing worked. partial: in between. */
export function runStatus(
  counts: Partial<Record<ScanSourceId, SourceRunCounts>>,
  failedWrites: number,
): Exclude<RunStatus, 'running'> {
  const active = Object.values(counts).filter(
    (c) => c.status !== 'disabled' && c.status !== 'skipped',
  );
  if (active.length > 0 && active.every((c) => c.status === 'failing')) return 'failed';
  if (failedWrites > 0 || active.some((c) => c.status !== 'ok')) return 'partial';
  return 'succeeded';
}

function sourceCode(error: unknown): string {
  const code = errorFields(error).errorCode;
  return typeof code === 'string' && /^[a-z0-9_]{1,60}$/.test(code) ? code : 'internal';
}

export async function runScan(deps: ScanDeps): Promise<ScanResult> {
  const { store } = deps;
  const startedAt = deps.now();
  const runId = store.newRunId();

  const lock = await store.acquireLock(runId, startedAt, deps.cooldownMs);
  if (!lock.ok) {
    log.info('scan.refused', { reason: lock.reason });
    if (lock.reason === 'running') return { status: 'busy' };
    const waitMs = lock.lastFinishedAt.getTime() + deps.cooldownMs - startedAt.getTime();
    return {
      status: 'skipped_recent',
      lastFinishedAt: lock.lastFinishedAt.toISOString(),
      retryAfterSeconds: Math.max(0, Math.ceil(waitMs / 1000)),
    };
  }

  const run: Run = {
    trigger: deps.trigger,
    status: 'running',
    startedAt,
    perSource: {},
    perStage: {},
    costPence: 0,
    errors: [],
    schemaVersion: 1,
  };
  try {
    await store.createRun(runId, run);
    log.info('scan.started', { runId, trigger: deps.trigger });

    const seeded = await store.ensureSeedCompanies(deps.seed, startedAt);
    if (seeded > 0) log.info('watchlist.seeded', { created: seeded });
    const [stored, states, criteria] = await Promise.all([
      store.watchedCompanies(),
      store.sourceStates(),
      deps.readCriteria().catch((error: unknown) => {
        log.error('scan.failed', { step: 'criteria', ...errorFields(error) });
        run.errors.push({ code: 'criteria_invalid' });
        return null;
      }),
    ]);
    const companies = stored.map((entry) => entry.company);

    // ---- Fetch every source in parallel ----
    const deadline = startedAt.getTime() + SCAN.fetchBudgetMs;
    const sources = deps.createSources();
    const disabled = new Set(deps.disabledSources);
    const outcomes = await Promise.all(
      SCAN_SOURCE_IDS.map(async (id): Promise<[ScanSourceId, SourceOutcome]> => {
        if (disabled.has(id)) {
          return [
            id,
            {
              report: {
                status: 'disabled',
                fetched: 0,
                invalid: 0,
                errors: 0,
                boards: [],
                errorCode: 'disabled',
              },
              jobs: [],
              requests: 0,
              durationMs: 0,
            },
          ];
        }
        const quotaKey = QUOTA_SOURCES[id];
        const quota = quotaKey ? currentQuota(states[id]?.quota, startedAt) : undefined;
        const callBudget = quotaKey && quota ? remainingCalls(quota, QUOTAS[quotaKey]) : Infinity;
        const http = deps.httpFor(deadline);
        const source = sources[id];
        const began = Date.now();
        let jobs: unknown[] = [];
        let report: SourceReport;
        try {
          jobs = await source.fetch({
            http,
            companies,
            criteria,
            now: startedAt,
            secrets: deps.secrets,
            callBudget,
            queryCursor: states[id]?.queryCursor ?? 0,
          });
          report = source.health();
        } catch (error) {
          log.error('source.failed', { source: id, ...errorFields(error) });
          report = {
            ...source.health(),
            status: 'failing',
            errorCode: sourceCode(error),
          };
          report.errors += 1;
        }
        const requests = http.requests();
        return [
          id,
          {
            report,
            jobs,
            requests,
            durationMs: Date.now() - began,
            ...(quota ? { quota: addCalls(quota, requests) } : {}),
          },
        ];
      }),
    );

    // ---- Validate, normalise, dedupe ----
    const invalidBySource = new Map<ScanSourceId, number>();
    const normalised: NormalisedJob[] = [];
    for (const [id, outcome] of outcomes) {
      for (const candidate of outcome.jobs) {
        const parsed = RawJobSchema.safeParse(candidate);
        const job =
          parsed.success && parsed.data.sourceId === id ? normaliseRawJob(parsed.data) : null;
        if (job) normalised.push(job);
        else invalidBySource.set(id, (invalidBySource.get(id) ?? 0) + 1);
      }
      const invalid = invalidBySource.get(id) ?? 0;
      if (invalid > 0) log.warn('ingest.invalid_item', { source: id, count: invalid });
    }
    const groups = dedupeBatch(normalised);
    const existing = await store.findJobsByKeys([...new Set(groups.flatMap((g) => g.keys))]);
    const plan = planIngest(groups, existing);
    if (plan.counts.conflicts > 0) log.warn('dedupe.conflict', { count: plan.counts.conflicts });
    const { failedWrites } = await store.writePlan(plan, startedAt);
    if (failedWrites > 0) run.errors.push({ code: 'write_failed' });

    // ---- Records: companies, sources, run ----
    const previousScan = new Map(stored.map((entry) => [entry.company.id, entry.lastScan]));
    const companyUpdates = outcomes
      .filter(([id]) => ATS_SOURCES.has(id))
      .flatMap(([, outcome]) => outcome.report.boards)
      .map((board) => ({
        companyId: board.companyId,
        lastScan: companyScanUpdate(previousScan.get(board.companyId), board),
      }));
    await store.updateCompanies(companyUpdates, startedAt);

    const perSource: Partial<Record<ScanSourceId, SourceRunCounts>> = {};
    const health: Partial<Record<ScanSourceId, SourceHealth>> = {};
    const finishedAt = deps.now();
    for (const [id, outcome] of outcomes) {
      const tally = { new: 0, duplicate: 0, merged: 0 };
      for (const entry of plan.outcomes) if (entry.sourceId === id) tally[entry.outcome] += 1;
      const counts: SourceRunCounts = {
        status: outcome.report.status,
        fetched: outcome.report.fetched,
        invalid: outcome.report.invalid + (invalidBySource.get(id) ?? 0),
        ...tally,
        errors: outcome.report.errors,
        requests: outcome.requests,
        durationMs: outcome.durationMs,
        ...(outcome.report.errorCode ? { errorCode: outcome.report.errorCode } : {}),
      };
      perSource[id] = counts;
      if (counts.status === 'failing')
        run.errors.push({ sourceId: id, code: counts.errorCode ?? 'internal' });
      health[id] = nextSourceHealth(states[id], counts, finishedAt, {
        ...(outcome.quota ? { quota: outcome.quota } : {}),
        ...(outcome.report.nextQueryCursor === undefined
          ? {}
          : { queryCursor: outcome.report.nextQueryCursor }),
      });
      log.info('source.done', {
        source: id,
        status: counts.status,
        fetched: counts.fetched,
        new: counts.new,
        merged: counts.merged,
        duplicate: counts.duplicate,
        errors: counts.errors,
      });
    }
    await store.writeSourceHealth(health);

    const status = runStatus(perSource, failedWrites);
    const s0: S0Counts = plan.counts;
    const finished: Run = {
      ...run,
      status,
      finishedAt,
      perSource,
      perStage: { s0 },
      errors: run.errors.slice(0, 50),
    };
    await store.finishRun(runId, finished);
    log.info('scan.done', { runId, status, ...s0 });
    return {
      status: 'completed',
      runId,
      runStatus: status,
      perSource: Object.fromEntries(
        Object.entries(perSource).map(([id, c]) => [
          id,
          {
            status: c.status,
            fetched: c.fetched,
            new: c.new,
            duplicate: c.duplicate,
            merged: c.merged,
            errors: c.errors,
          },
        ]),
      ),
      s0,
    };
  } catch (error) {
    log.error('scan.failed', { runId, ...errorFields(error) });
    await store
      .finishRun(runId, {
        ...run,
        status: 'failed',
        finishedAt: deps.now(),
        errors: [...run.errors, { code: 'internal' }].slice(0, 50),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await store.releaseLock(runId, deps.now()).catch((error: unknown) => {
      log.error('scan.failed', { step: 'unlock', ...errorFields(error) });
    });
  }
}
