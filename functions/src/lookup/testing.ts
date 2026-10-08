import { JobSchema, type Job, type LockHolder, type Usage } from '@hireframe/shared';
import { applyPatch } from '../funnel/judgement.js';
import {
  memoryFunnelStore,
  testCriteria,
  TEST_FACTS,
  TEST_NOW,
  type MemoryFunnelStore,
} from '../funnel/testing.js';
import { fakeTransport } from '../llm/fake-transport.js';
import type { LlmRequest, LlmTransport } from '../llm/transport.js';
import {
  applyReserve,
  applySettle,
  dailyCapped,
  emptyUsage,
  type UsageStore,
} from '../llm/usage-store.js';
import { DailyCapExceededError, SpendCapExceededError } from '../llm/errors.js';
import type { LockResult } from '../scan/run.js';
import { FAKE_WATCHLIST } from '../sources/fixtures.js';
import { testHttpClient } from '../sources/testing.js';
import { createAtsSearch } from './ats-search.js';
import type { LookupDeps } from './run.js';
import {
  matchesPrecondition,
  type CommitResult,
  type JobChange,
  type LookupStore,
  type Precondition,
} from './store.js';

/** An in-memory `UsageStore` on the real reserve/settle rules, so cap math is the production's. */
export function memoryUsage(initial?: Usage): UsageStore & { state: () => Usage } {
  let usage = initial ?? emptyUsage(1_500, TEST_NOW);
  return {
    state: () => usage,
    reserve(input) {
      usage = applyReserve(usage, input);
      return Promise.resolve();
    },
    settle(input) {
      usage = applySettle(usage, input);
      return Promise.resolve();
    },
  };
}

/** Lets `allowed` reservations through, then refuses the rest with `error`. */
export function refuseAfter(
  inner: UsageStore,
  allowed: number,
  error: 'daily' | 'monthly',
): UsageStore {
  let seen = 0;
  return {
    reserve(input) {
      seen += 1;
      if (seen > allowed) {
        return Promise.reject(
          error === 'daily' ? new DailyCapExceededError() : new SpendCapExceededError(),
        );
      }
      return inner.reserve(input);
    },
    settle: (input) => inner.settle(input),
  };
}

export interface MemoryLookupStore extends LookupStore {
  /** Runs before a commit's precondition check, to simulate a scan landing in between. */
  beforeCommit?: (jobId: string, call: number) => void;
  commits: { jobId: string; result: CommitResult }[];
  /** IDs `createJobs` should fail for. */
  failCreates: Set<string>;
}

export function memoryLookupStore(funnel: MemoryFunnelStore): MemoryLookupStore {
  let counter = 0;
  let calls = 0;
  const store: MemoryLookupStore = {
    commits: [],
    failCreates: new Set(),
    newJobId: () => {
      counter += 1;
      return `L${String(counter)}`;
    },
    createJobs(items) {
      const failed: string[] = [];
      for (const item of items) {
        if (store.failCreates.has(item.id)) {
          failed.push(item.id);
          continue;
        }
        funnel.add(item.id, item.job, item.description.text);
      }
      return Promise.resolve(failed);
    },
    commit(jobId, pre: Precondition, change: JobChange, now) {
      calls += 1;
      store.beforeCommit?.(jobId, calls);
      const job = funnel.jobs.get(jobId);
      const result: CommitResult = !job
        ? 'missing'
        : matchesPrecondition(job, pre)
          ? 'applied'
          : 'dropped';
      store.commits.push({ jobId, result });
      if (job && result === 'applied') {
        let next: Job = applyPatch(job, change.patch, now);
        if (change.attach) {
          const { attach } = change;
          next = {
            ...next,
            descriptionKind: 'full',
            sources: [...next.sources, ...attach.addSources],
            keys: [...next.keys, ...attach.addKeys],
            ...(attach.postedAt ? { postedAt: attach.postedAt } : {}),
          };
          funnel.texts.set(jobId, attach.description.text);
        }
        if (change.companyId) next = { ...next, companyId: change.companyId };
        if (change.describingAt === 'clear') delete next.describingAt;
        funnel.jobs.set(jobId, JobSchema.parse(next));
      }
      return Promise.resolve(result);
    },
    claimDescription(jobId, now, staleMs) {
      const job = funnel.jobs.get(jobId);
      if (!job) return Promise.resolve(null);
      const waiting = job.next === 'description';
      const abandoned =
        (job.next ?? null) === null &&
        job.describingAt !== undefined &&
        now.getTime() - job.describingAt.getTime() > staleMs &&
        job.judgedAt === undefined;
      if (!waiting && !abandoned) return Promise.resolve(null);
      const claimed = JobSchema.parse({ ...job, next: null, describingAt: now, updatedAt: now });
      funnel.jobs.set(jobId, claimed);
      return Promise.resolve(claimed);
    },
    saveDescription(jobId, description) {
      funnel.texts.set(jobId, description.text);
      const job = funnel.jobs.get(jobId);
      if (job) funnel.jobs.set(jobId, { ...job, descriptionKind: 'full' });
      return Promise.resolve();
    },
  };
  return store;
}

/** The fake transport, recording what it was asked. */
export function recordingTransport(inner: LlmTransport = fakeTransport()) {
  const sent: LlmRequest[] = [];
  const transport: LlmTransport = {
    countTokens: (request) => inner.countTokens(request),
    send: (request) => {
      sent.push(request);
      return inner.send(request);
    },
  };
  return { transport, sent };
}

export interface LookupHarness {
  deps: LookupDeps;
  funnel: MemoryFunnelStore;
  store: MemoryLookupStore;
  usage: ReturnType<typeof memoryUsage>;
  sent: LlmRequest[];
  locks: { acquired: LockHolder[]; released: string[] };
  /** What `acquireLock` answers, in order; the last repeats. Default: ok. */
  lockAnswers: LockResult[];
  clock: () => number;
}

export function lookupHarness(
  options: {
    usage?: UsageStore;
    dailyCapPence?: number;
    criteria?: boolean;
    facts?: boolean;
    transport?: LlmTransport;
  } = {},
): LookupHarness {
  let clock = TEST_NOW.getTime();
  const funnel = memoryFunnelStore({ facts: options.facts === false ? [] : TEST_FACTS });
  const store = memoryLookupStore(funnel);
  const usage = memoryUsage();
  const { transport, sent } = recordingTransport(options.transport);
  const lockAnswers: LockResult[] = [{ ok: true }];
  const locks: LookupHarness['locks'] = { acquired: [], released: [] };
  let lockCalls = 0;
  const deps: LookupDeps = {
    scan: {
      newRunId: () => 'run1',
      acquireLock: (_runId, _now, _cooldown, holder = 'scan') => {
        const answer = lockAnswers[Math.min(lockCalls, lockAnswers.length - 1)] ?? { ok: true };
        lockCalls += 1;
        if (answer.ok) locks.acquired.push(holder);
        return Promise.resolve(answer);
      },
      releaseLock: (runId) => {
        locks.released.push(runId);
        return Promise.resolve();
      },
      findJobsByKeys: (keys) => {
        const wanted = new Set(keys);
        return Promise.resolve(
          [...funnel.jobs.entries()]
            .filter(([, job]) => job.keys.some((key) => wanted.has(key)))
            .map(([id, job]) => ({
              id,
              keys: job.keys,
              firstSeenAt: job.firstSeenAt,
              sourceCount: job.sources.length,
            })),
        );
      },
    },
    store,
    funnel,
    readCriteria: () => Promise.resolve(options.criteria === false ? null : testCriteria()),
    llm: {
      transport,
      usage: dailyCapped(options.usage ?? usage, 'lookup', options.dailyCapPence ?? 25),
      capPence: 1_500,
      fxUsdToGbp: 0.85,
      now: () => new Date(clock),
      newId: (() => {
        let id = 0;
        return () => {
          id += 1;
          return `lookup-${String(id)}`;
        };
      })(),
    },
    ats: createAtsSearch({
      http: testHttpClient(),
      watched: () => Promise.resolve(FAKE_WATCHLIST),
      maxBoards: 12,
    }),
    now: () => new Date(clock),
    clock: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    startedAtMs: clock,
  };
  return { deps, funnel, store, usage, sent, locks, lockAnswers, clock: () => clock };
}
