import {
  buildNewJob,
  CRITERIA_SEED_V1,
  JobSchema,
  type CompanySeed,
  type ExistingJobKeys,
  type IngestPlan,
  type Job,
  type Quota,
  type Run,
  type ScanSourceId,
  type SourceHealth,
} from '@hireframe/shared';
import { afterEach, describe, expect, it } from 'vitest';

import type { FunnelOutcome } from '../funnel/run.js';
import { setLogSink, type LogEvent, type LogFields } from '../log.js';
import { fakeFetch } from '../sources/fake-fetch.js';
import { FAKE_SEED, GREENHOUSE_BOARD } from '../sources/fixtures.js';
import { createSources } from '../sources/index.js';
import { testHttpClient } from '../sources/testing.js';
import type { Source } from '../sources/types.js';
import {
  companyScanUpdate,
  nextSourceHealth,
  runScan,
  runStatus,
  type LockResult,
  type ScanDeps,
  type ScanStore,
  type StoredCompany,
} from './run.js';

const NOW = new Date('2026-10-01T08:00:00Z');

/** An in-memory ScanStore with the same semantics as the Firestore one. */
function memoryStore(options: { lock?: LockResult } = {}) {
  const jobs = new Map<string, Job>();
  const runs = new Map<string, Run>();
  const companies = new Map<string, StoredCompany>();
  const sources: Partial<Record<ScanSourceId, SourceHealth>> = {};
  const quotas: Partial<Record<ScanSourceId, Quota>> = {};
  let nextId = 0;
  let locked = false;
  const calls = { writes: 0, releases: 0 };
  const store: ScanStore = {
    newRunId: () => `run-${String(++nextId)}`,
    acquireLock: () => {
      if (options.lock) return Promise.resolve(options.lock);
      if (locked) return Promise.resolve({ ok: false, reason: 'running' } as const);
      locked = true;
      return Promise.resolve({ ok: true } as const);
    },
    releaseLock: () => {
      locked = false;
      calls.releases += 1;
      return Promise.resolve();
    },
    createRun: (id, run) => Promise.resolve(void runs.set(id, run)),
    finishRun: (id, run) => Promise.resolve(void runs.set(id, run)),
    ensureSeedCompanies: (seed: readonly CompanySeed[]) => {
      let created = 0;
      for (const company of seed) {
        if (companies.has(company.id)) continue;
        companies.set(company.id, {
          company: { id: company.id, name: company.name, ats: company.ats },
        });
        created += 1;
      }
      return Promise.resolve(created);
    },
    watchedCompanies: () => Promise.resolve([...companies.values()]),
    sourceStates: () => Promise.resolve({ ...sources }),
    quotas: () => Promise.resolve({ ...quotas }),
    saveQuota: (id, quota) => {
      quotas[id] = quota;
      return Promise.resolve();
    },
    findJobsByKeys: (keys) => {
      const wanted = new Set(keys);
      const found: ExistingJobKeys[] = [...jobs.entries()]
        .filter(([, job]) => job.keys.some((key) => wanted.has(key)))
        .map(([id, job]) => ({
          id,
          keys: job.keys,
          firstSeenAt: job.firstSeenAt,
          sourceCount: job.sources.length,
        }));
      return Promise.resolve(found);
    },
    writePlan: (plan: IngestPlan, now) => {
      for (const group of plan.creates) {
        const id = `job-${String(jobs.size + 1)}`;
        jobs.set(id, buildNewJob(group, `jobs/${id}/description/raw`, now).job);
        calls.writes += 1;
      }
      for (const update of plan.updates) {
        const job = jobs.get(update.jobId);
        if (!job) continue;
        job.sources.push(
          ...update.addSources.map((s) => ({
            id: s.sourceId,
            url: s.url,
            externalId: s.externalId,
            seenAt: now,
          })),
        );
        job.keys.push(...update.addKeys);
        calls.writes += 1;
      }
      return Promise.resolve({ failedWrites: 0 });
    },
    updateCompanies: (updates, now) => {
      for (const { companyId, lastScan } of updates) {
        const entry = companies.get(companyId);
        if (entry) {
          entry.lastScan = lastScan;
          entry.company.lastScannedAt = now;
        }
      }
      return Promise.resolve({ failedWrites: 0 });
    },
    writeSourceHealth: (states) => {
      Object.assign(sources, states);
      for (const [id, health] of Object.entries(states)) {
        if (health.quota) quotas[id as ScanSourceId] = health.quota;
      }
      return Promise.resolve();
    },
  };
  return { store, jobs, runs, companies, sources, quotas, calls };
}

function deps(store: ScanStore, overrides: Partial<ScanDeps> = {}): ScanDeps {
  return {
    store,
    readCriteria: () => Promise.resolve(CRITERIA_SEED_V1),
    createSources,
    httpFor: () => testHttpClient(),
    secrets: { reedApiKey: 'fake', adzunaAppId: 'fake', adzunaAppKey: 'fake' },
    seed: FAKE_SEED,
    disabledSources: [],
    cooldownMs: 0,
    trigger: 'manual',
    now: () => NOW,
    ...overrides,
  };
}

const logs: { event: LogEvent; fields: LogFields }[] = [];
afterEach(() => {
  setLogSink();
  logs.length = 0;
});
function captureLogs() {
  setLogSink((_level, event, fields) => logs.push({ event, fields }));
}

describe('runScan', () => {
  it('ingests every source, merges duplicates across sources, and records counts (R4, R5)', async () => {
    const memory = memoryStore();
    const result = await runScan(deps(memory.store));
    if (result.status !== 'completed') throw new Error(result.status);

    expect(result.runStatus).toBe('partial'); // the fake watchlist has one missing board
    // Acme's Product Analyst arrives from Greenhouse, Adzuna and HN: one job, three sources.
    const acme = [...memory.jobs.values()].find(
      (job) => job.title === 'Product Analyst' && job.company === 'Acme Analytics',
    );
    expect(acme?.sources.map((s) => s.id).sort()).toEqual(['adzuna', 'greenhouse', 'hn']);
    // Senior and Junior at Bramble stay apart; Reed's noisy title merges into Cobalt's Ashby job.
    const titles = [...memory.jobs.values()].map((job) => `${job.company}: ${job.title}`);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Bramble Software: Senior Product Analyst',
        'Bramble Software: Junior Product Analyst',
      ]),
    );
    const cobalt = [...memory.jobs.values()].find((job) => job.company === 'Cobalt Ledger');
    expect(cobalt?.sources.map((s) => s.id).sort()).toEqual(['ashby', 'reed']);
    for (const job of memory.jobs.values()) expect(JobSchema.safeParse(job).success).toBe(true);

    expect(result.perSource.greenhouse).toMatchObject({
      status: 'degraded',
      fetched: 3,
      new: 2,
      errors: 1,
    });
    expect(result.perSource.adzuna).toMatchObject({ status: 'ok', merged: 1, new: 0 });
    expect(result.s0.new).toBe(memory.jobs.size);
    expect(result.s0.in).toBe(result.s0.new + result.s0.merged + result.s0.duplicate);

    const run = memory.runs.get(result.runId);
    expect(run).toMatchObject({ status: 'partial', costPence: 0, perStage: { s0: result.s0 } });
    expect(run?.finishedAt).toEqual(NOW);
    expect(memory.calls.releases).toBe(1);
  });

  it('writes nothing on a second run over the same postings', async () => {
    const memory = memoryStore();
    await runScan(deps(memory.store));
    const writesAfterFirst = memory.calls.writes;
    const second = await runScan(deps(memory.store));
    if (second.status !== 'completed') throw new Error(second.status);
    expect(second.s0).toMatchObject({ new: 0, merged: 0 });
    expect(second.s0.duplicate).toBe(second.s0.in);
    expect(memory.calls.writes).toBe(writesAfterFirst);
  });

  it('keeps going when a source throws, and marks it failing', async () => {
    const memory = memoryStore();
    const broken: Source = {
      id: 'hn',
      fetch: () => Promise.reject(Object.assign(new Error('boom'), { code: 'kaput' })),
      health: () => ({ status: 'ok', fetched: 0, invalid: 0, errors: 0, boards: [] }),
    };
    const result = await runScan(
      deps(memory.store, { createSources: () => ({ ...createSources(), hn: broken }) }),
    );
    if (result.status !== 'completed') throw new Error(result.status);
    expect(result.perSource.hn).toMatchObject({ status: 'failing', errors: 1 });
    expect(result.perSource.lever?.status).toBe('ok');
    expect(memory.runs.get(result.runId)?.errors).toContainEqual({ sourceId: 'hn', code: 'kaput' });
    expect(memory.sources.hn).toMatchObject({ status: 'failing', consecutiveFailures: 1 });
  });

  it('skips disabled sources and records them as disabled', async () => {
    const memory = memoryStore();
    const result = await runScan(
      deps(memory.store, { disabledSources: ['adzuna', 'not-a-source'] }),
    );
    if (result.status !== 'completed') throw new Error(result.status);
    expect(result.perSource.adzuna).toMatchObject({ status: 'disabled', fetched: 0 });
  });

  it('counts postings that fail RawJobSchema as invalid', async () => {
    const memory = memoryStore();
    const odd: Source = {
      id: 'hn',
      fetch: () =>
        Promise.resolve([{ sourceId: 'hn', externalId: '1', url: 'nope' }, { sourceId: 'lever' }]),
      health: () => ({ status: 'ok', fetched: 2, invalid: 0, errors: 0, boards: [] }),
    } as unknown as Source;
    const result = await runScan(
      deps(memory.store, { createSources: () => ({ ...createSources(), hn: odd }) }),
    );
    if (result.status !== 'completed') throw new Error(result.status);
    expect(memory.runs.get(result.runId)?.perSource.hn).toMatchObject({ invalid: 2, new: 0 });
  });

  it('reports busy while another scan holds the lock, and skipped_recent in the cooldown', async () => {
    const busy = await runScan(deps(memoryStore({ lock: { ok: false, reason: 'running' } }).store));
    expect(busy).toEqual({ status: 'busy' });
    const lastFinishedAt = new Date(NOW.getTime() - 60_000);
    const recent = await runScan(
      deps(memoryStore({ lock: { ok: false, reason: 'recent', lastFinishedAt } }).store, {
        cooldownMs: 5 * 60_000,
      }),
    );
    expect(recent).toEqual({
      status: 'skipped_recent',
      lastFinishedAt: lastFinishedAt.toISOString(),
      retryAfterSeconds: 240,
    });
  });

  it('records the API quota and the query cursor for Reed and Adzuna', async () => {
    const memory = memoryStore();
    await runScan(deps(memory.store));
    expect(memory.sources.adzuna?.quota).toMatchObject({ day: '2026-10-01', dayCount: 20 });
    expect(memory.sources.adzuna?.queryCursor).toBeGreaterThan(0);
    expect(memory.sources.reed?.quota?.dayCount).toBeLessThanOrEqual(30);
  });

  it('never stores or logs the API keys', async () => {
    captureLogs();
    const memory = memoryStore();
    const secrets = {
      reedApiKey: 'REED-SECRET-1',
      adzunaAppId: 'ADZ-ID-2',
      adzunaAppKey: 'ADZ-KEY-3',
    };
    await runScan(deps(memory.store, { secrets }));
    const stored = JSON.stringify([
      [...memory.jobs.values()],
      [...memory.runs.values()],
      memory.sources,
      memory.quotas,
    ]);
    const logged = JSON.stringify(logs);
    for (const secret of Object.values(secrets)) {
      expect(stored).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
  });

  it('keeps the API calls in the quota even when the run fails afterwards (R2)', async () => {
    const memory = memoryStore();
    const writePlan = memory.store.writePlan.bind(memory.store);
    memory.store.writePlan = () => Promise.reject(new Error('firestore down'));
    await expect(runScan(deps(memory.store))).rejects.toThrow('firestore down');
    expect(memory.quotas.adzuna).toMatchObject({ day: '2026-10-01', dayCount: 20 });
    expect(memory.quotas.reed?.dayCount).toBeGreaterThan(0);
    // The next run starts from those counts.
    memory.store.writePlan = writePlan;
    await runScan(deps(memory.store));
    expect(memory.quotas.adzuna?.dayCount).toBe(40);
  });

  it('counts failed company updates and reports the run as partial', async () => {
    const memory = memoryStore();
    memory.store.updateCompanies = (updates) => Promise.resolve({ failedWrites: updates.length });
    const result = await runScan(deps(memory.store));
    if (result.status !== 'completed') throw new Error(result.status);
    expect(result.runStatus).toBe('partial');
    expect(memory.runs.get(result.runId)?.errors).toContainEqual({ code: 'company_write_failed' });
  });

  it('marks the run failed and still unlocks when the store breaks', async () => {
    const memory = memoryStore();
    memory.store.findJobsByKeys = () => Promise.reject(new Error('down'));
    await expect(runScan(deps(memory.store))).rejects.toThrow('down');
    expect([...memory.runs.values()][0]?.status).toBe('failed');
    expect(memory.calls.releases).toBe(1);
  });

  it('runs without criteria: Reed and Adzuna are skipped, the boards still scan', async () => {
    const memory = memoryStore();
    const result = await runScan(deps(memory.store, { readCriteria: () => Promise.resolve(null) }));
    if (result.status !== 'completed') throw new Error(result.status);
    expect(result.perSource.reed?.status).toBe('skipped');
    expect(result.perSource.greenhouse?.fetched).toBe(GREENHOUSE_BOARD.jobs.length);
  });

  it('never logs job text, titles or URLs', async () => {
    captureLogs();
    await runScan(deps(memoryStore().store));
    const text = JSON.stringify(logs);
    expect(text).not.toContain('Product Analyst');
    expect(text).not.toContain('reporting tools');
    expect(text).not.toContain('https://');
    expect(logs.map((log) => log.event)).toContain('scan.done');
  });
});

describe('paused hosts across scans', () => {
  it('carries a pause to the next scan, which then sends Workable nothing', async () => {
    const memory = memoryStore();
    let workableRequests = 0;
    const httpFor: ScanDeps['httpFor'] = (_deadline, paused) =>
      testHttpClient({
        paused,
        fetch: ((input: URL) => {
          if (input.host === 'apply.workable.com' && input.pathname !== '/robots.txt') {
            workableRequests += 1;
            return Promise.resolve(
              new Response('error code: 1015', {
                status: 429,
                headers: { 'retry-after': '83997' },
              }),
            );
          }
          return fakeFetch(input);
        }) as typeof fetch,
      });

    const first = await runScan(deps(memory.store, { httpFor }));
    if (first.status !== 'completed') throw new Error(first.status);
    expect(first.perSource.workable?.status).toBe('failing');
    expect(workableRequests).toBe(1);
    const pause = memory.sources.workable?.pausedHosts?.[0];
    expect(pause?.host).toBe('apply.workable.com');
    expect(pause?.until.getTime()).toBeGreaterThan(NOW.getTime() + 23 * 3600_000);
    const lastScanAfterFirst = memory.companies.get('delta-dock')?.lastScan;

    const second = await runScan(deps(memory.store, { httpFor }));
    if (second.status !== 'completed') throw new Error(second.status);
    expect(workableRequests).toBe(1);
    expect(second.perSource.workable?.status).toBe('skipped');
    expect(memory.sources.workable?.pausedHosts).toEqual(memory.sources.workable?.pausedHosts);
    expect(memory.sources.workable?.pausedHosts?.[0]?.until).toEqual(pause?.until);
    // A skipped board is neither a failure nor "scanned".
    expect(memory.companies.get('delta-dock')?.lastScan).toEqual(lastScanAfterFirst);
  });
});

describe('Workable rotation across scans', () => {
  it('fetches the boards the last scan deferred first', async () => {
    const seed: CompanySeed[] = Array.from({ length: 50 }, (_, i) => {
      const id = `wk-${String(i).padStart(2, '0')}`;
      return {
        id,
        name: id,
        domain: `${id}.example.com`,
        ats: { type: 'workable', token: id },
        hq: 'London',
      };
    });
    const memory = memoryStore();
    const fetched: string[][] = [];
    let run: string[] = [];
    const recording = () =>
      testHttpClient({
        fetch: ((input: URL) => {
          const token = /\/widget\/accounts\/([^?]+)/.exec(input.toString())?.[1];
          if (token) run.push(token);
          return Promise.resolve(new Response('', { status: 404 }));
        }) as typeof fetch,
      });
    let clock = NOW.getTime();
    for (let i = 0; i < 2; i++) {
      run = [];
      clock += 60 * 60_000;
      const at = new Date(clock);
      await runScan(deps(memory.store, { seed, httpFor: recording, now: () => at }));
      fetched.push(run);
    }
    const [first = [], second = []] = fetched;
    expect(first).toHaveLength(36);
    expect(second).toHaveLength(36);
    const skippedFirst = seed.map((c) => c.id).filter((id) => !first.includes(id));
    expect(skippedFirst).toHaveLength(14);
    // The 14 boards the first scan left out lead the second scan.
    expect(second.slice(0, 14).sort()).toEqual(skippedFirst);
    expect(new Set([...first, ...second]).size).toBe(50);
  });
});

describe('companyScanUpdate', () => {
  it('counts consecutive failures and marks a board broken after 3 not_found runs', () => {
    let lastScan = companyScanUpdate(undefined, {
      companyId: 'x',
      status: 'not_found',
      jobs: 0,
      errorCode: 'not_found',
    });
    expect(lastScan).toMatchObject({ consecutiveFailures: 1, broken: false });
    lastScan = companyScanUpdate(lastScan, { companyId: 'x', status: 'not_found', jobs: 0 });
    lastScan = companyScanUpdate(lastScan, { companyId: 'x', status: 'not_found', jobs: 0 });
    expect(lastScan).toMatchObject({ consecutiveFailures: 3, broken: true });
    expect(companyScanUpdate(lastScan, { companyId: 'x', status: 'ok', jobs: 4 })).toEqual({
      status: 'ok',
      jobs: 4,
      consecutiveFailures: 0,
      broken: false,
    });
  });
});

describe('nextSourceHealth and runStatus', () => {
  const counts = {
    status: 'ok',
    fetched: 1,
    invalid: 0,
    new: 1,
    duplicate: 0,
    merged: 0,
    errors: 0,
    requests: 1,
    durationMs: 5,
  } as const;

  it('tracks the last success and consecutive failures', () => {
    const ok = nextSourceHealth(undefined, counts, NOW, {});
    expect(ok).toMatchObject({ status: 'ok', lastOkAt: NOW, consecutiveFailures: 0 });
    const later = new Date(NOW.getTime() + 1000);
    const failing = nextSourceHealth(
      ok,
      { ...counts, status: 'failing', errorCode: 'timeout' },
      later,
      {},
    );
    expect(failing).toMatchObject({
      lastOkAt: NOW,
      consecutiveFailures: 1,
      lastErrorCode: 'timeout',
    });
  });

  it('is succeeded, partial or failed', () => {
    expect(runStatus({ lever: counts, reed: { ...counts, status: 'disabled' } }, 0)).toBe(
      'succeeded',
    );
    expect(runStatus({ lever: counts }, 2)).toBe('partial');
    expect(runStatus({ lever: { ...counts, status: 'degraded' } }, 0)).toBe('partial');
    expect(
      runStatus(
        { lever: { ...counts, status: 'failing' }, reed: { ...counts, status: 'skipped' } },
        0,
      ),
    ).toBe('failed');
  });
});

describe('the funnel after ingest (M4)', () => {
  const outcome = (patch: Partial<FunnelOutcome> = {}): FunnelOutcome => ({
    perStage: {
      s1: { in: 3, passed: 2, skipped: 1, byRule: { 'title:senior': 1 } },
      s2: {
        in: 2,
        passed: 1,
        skipped: 1,
        expired: 0,
        review: 0,
        queued: 0,
        costPence: 0.3,
        durationMs: 5,
      },
      hydrate: { attempted: 0, ok: 0, failed: 0 },
      s3: {
        in: 1,
        apply: 1,
        near_miss: 0,
        wildcard: 0,
        skip: 0,
        expired: 0,
        review: 0,
        queued: 0,
        drift: 0,
        recomputed: 0,
        costPence: 1.5,
        durationMs: 9,
      },
    },
    budget: { leasePence: 24, usedPence: 1.8 },
    flags: ['spend_80'],
    costPence: 1.8,
    summary: {
      s1: { passed: 2, skipped: 1 },
      s2: { passed: 1, skipped: 1 },
      s3: { apply: 1, near_miss: 0, wildcard: 0, skip: 0 },
      review: 0,
      queued: { s2: 0, s3: 0 },
      costPence: 1.8,
    },
    failedWrites: 0,
    sweepFailed: false,
    ...patch,
  });

  it('runs the funnel inside the lock and records stages, cost and flags on the run', async () => {
    const memory = memoryStore();
    let lockedDuringFunnel = false;
    const result = await runScan(
      deps(memory.store, {
        funnel: async ({ runId }) => {
          // A second scan can't start while the funnel runs.
          lockedDuringFunnel = !(await memory.store.acquireLock('other', NOW, 0)).ok;
          expect(runId).toBe('run-1');
          return outcome();
        },
      }),
    );
    if (result.status !== 'completed') throw new Error(result.status);
    expect(lockedDuringFunnel).toBe(true);
    expect(result.funnel?.s3.apply).toBe(1);
    const run = memory.runs.get('run-1');
    expect(run?.perStage.s0).toBeDefined();
    expect(run?.perStage).toMatchObject({ s1: { in: 3 }, s3: { apply: 1 } });
    expect(run).toMatchObject({ costPence: 1.8, budget: { leasePence: 24 }, flags: ['spend_80'] });
  });

  it('makes the run partial and records the code when the expiry sweep failed', async () => {
    const memory = memoryStore();
    const result = await runScan(
      deps(memory.store, {
        disabledSources: ['greenhouse', 'lever', 'ashby', 'workable', 'adzuna', 'hn'],
        funnel: () => Promise.resolve(outcome({ sweepFailed: true })),
      }),
    );
    if (result.status !== 'completed') throw new Error(result.status);
    expect(result.runStatus).toBe('partial');
    expect(memory.runs.get('run-1')?.errors).toContainEqual({ code: 'funnel_sweep_failed' });
  });

  it('makes the run partial, never failed, when the funnel throws', async () => {
    const memory = memoryStore();
    captureLogs();
    const result = await runScan(
      deps(memory.store, {
        disabledSources: ['greenhouse', 'lever', 'ashby', 'workable', 'adzuna', 'hn'],
        funnel: () => Promise.reject(new Error('criteria unreadable')),
      }),
    );
    if (result.status !== 'completed') throw new Error(result.status);
    expect(result.runStatus).toBe('partial');
    expect(result.funnel).toBeUndefined();
    expect(memory.runs.get('run-1')?.errors).toContainEqual({ code: 'funnel_failed' });
    expect(logs.some((l) => l.event === 'scan.failed' && l.fields.step === 'funnel')).toBe(true);
  });
});

describe('the scheduled scan and short lock holders (ADR-048)', () => {
  /** A store whose lock answers from a script, then lets the scan take it. */
  function scripted(answers: LockResult[]) {
    const memory = memoryStore();
    const attempts: Date[] = [];
    const store: ScanStore = {
      ...memory.store,
      acquireLock: (_runId, now) => {
        attempts.push(now);
        return Promise.resolve(answers.shift() ?? ({ ok: true } as const));
      },
    };
    return { memory, store, attempts };
  }

  function waiting(clock: { t: number }, slept: number[]): Partial<ScanDeps> {
    return {
      now: () => new Date(clock.t),
      trigger: 'schedule',
      waitForShortHolders: {
        intervalMs: 15_000,
        maxMs: 4 * 60_000,
        sleep: (ms) => {
          slept.push(ms);
          clock.t += ms;
          return Promise.resolve();
        },
      },
    };
  }

  const email: LockResult = { ok: false, reason: 'running', holder: 'email' };

  it('waits for an email holder, retrying every 15 s, then runs', async () => {
    const clock = { t: NOW.getTime() };
    const slept: number[] = [];
    const { memory, store, attempts } = scripted([email, email]);
    const result = await runScan(deps(store, waiting(clock, slept)));
    if (result.status !== 'completed') throw new Error(result.status);
    expect(slept).toEqual([15_000, 15_000]);
    expect(attempts).toHaveLength(3);
    // The run's own clock starts once it has the lock.
    expect(memory.runs.get(result.runId)?.startedAt.getTime()).toBe(NOW.getTime() + 30_000);
  });

  it('gives up after 4 minutes and reports busy with the holder', async () => {
    const clock = { t: NOW.getTime() };
    const slept: number[] = [];
    const { store } = scripted(Array(100).fill(email) as LockResult[]);
    const result = await runScan(deps(store, waiting(clock, slept)));
    expect(result).toEqual({ status: 'busy', holder: 'email' });
    expect(slept.reduce((a, b) => a + b, 0)).toBe(4 * 60_000);
  });

  it('skips at once when a scan holds the lock', async () => {
    const clock = { t: NOW.getTime() };
    const slept: number[] = [];
    const { store } = scripted([{ ok: false, reason: 'running', holder: 'scan' }]);
    const result = await runScan(deps(store, waiting(clock, slept)));
    expect(result).toEqual({ status: 'busy', holder: 'scan' });
    expect(slept).toEqual([]);
  });

  it('a manual scan never waits: it reports busy and names the holder', async () => {
    const { store } = scripted([email]);
    expect(await runScan(deps(store))).toEqual({ status: 'busy', holder: 'email' });
  });
});
