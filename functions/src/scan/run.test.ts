import {
  buildNewJob,
  CRITERIA_SEED_V1,
  JobSchema,
  type CompanySeed,
  type ExistingJobKeys,
  type IngestPlan,
  type Job,
  type Run,
  type ScanSourceId,
  type SourceHealth,
} from '@hireframe/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { setLogSink, type LogEvent, type LogFields } from '../log.js';
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
      return Promise.resolve();
    },
    writeSourceHealth: (states) => {
      Object.assign(sources, states);
      return Promise.resolve();
    },
  };
  return { store, jobs, runs, companies, sources, calls };
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
          const token = /\/api\/accounts\/([^?]+)/.exec(input.toString())?.[1];
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
    expect(first).toHaveLength(43);
    expect(second).toHaveLength(43);
    const skippedFirst = seed.map((c) => c.id).filter((id) => !first.includes(id));
    expect(skippedFirst).toHaveLength(7);
    // The 7 boards the first scan left out lead the second scan.
    expect(second.slice(0, 7).sort()).toEqual(skippedFirst);
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
