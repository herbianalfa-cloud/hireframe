/**
 * runScan against the Firestore emulator with the real store and the fake job APIs (ADR-029,
 * ADR-030). Run with `npm run test:rules`. Proves: jobs, descriptions, runs, sources and
 * companies are written; a second run writes no job; the LinkedIn-alert job already stored
 * gains the Greenhouse source instead of a duplicate job (PRD R5); the lock, its takeover and
 * the cooldown; seed companies are never overwritten.
 */
import {
  buildNewJob,
  COLLECTIONS,
  CompanySchema,
  CRITERIA_SEED_V1,
  dedupeBatch,
  DOCS,
  JobDescriptionSchema,
  JobSchema,
  normaliseRawJob,
  PATHS,
  RunSchema,
  SourceHealthSchema,
} from '@hireframe/shared';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LINKEDIN_ALERT_JOB } from '../../packages/shared/src/fixtures/jobs.js';
import { runScan, type ScanDeps } from '../../functions/src/scan/run.js';
import { firestoreScanStore } from '../../functions/src/scan/store.js';
import { FAKE_SEED } from '../../functions/src/sources/fixtures.js';
import { createSources } from '../../functions/src/sources/index.js';
import { testHttpClient } from '../../functions/src/sources/testing.js';
import { timestampsToDates } from '../../functions/src/timestamps.js';

const T0 = new Date('2026-10-01T08:00:00Z');

let app: App;
let db: Firestore;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run with `npm run test:rules`.');
  app = initializeApp({ projectId: 'demo-hireframe' }, 'scan-test');
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  for (const path of ['jobs', 'runs', 'sources', 'companies', 'locks']) {
    await db.recursiveDelete(db.collection(path));
  }
});

function deps(now: Date, overrides: Partial<ScanDeps> = {}): ScanDeps {
  return {
    store: firestoreScanStore(db),
    readCriteria: () => Promise.resolve(CRITERIA_SEED_V1),
    createSources,
    httpFor: () => testHttpClient(),
    secrets: { reedApiKey: 'fake', adzunaAppId: 'fake', adzunaAppKey: 'fake' },
    seed: FAKE_SEED,
    disabledSources: [],
    cooldownMs: 5 * 60_000,
    trigger: 'manual',
    now: () => now,
    ...overrides,
  };
}

const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

async function allJobs() {
  const snapshot = await db.collection(COLLECTIONS.jobs).get();
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    updateTime: doc.updateTime.toMillis(),
    job: JobSchema.parse(timestampsToDates(doc.data())),
  }));
}

describe('runScan on the Firestore emulator', () => {
  it('writes valid jobs, descriptions, run, source and company records', async () => {
    const result = await runScan(deps(T0));
    if (result.status !== 'completed') throw new Error(result.status);

    const jobs = await allJobs();
    expect(jobs.length).toBe(result.s0.new);
    for (const { id, job } of jobs) {
      expect(job.stage).toBe('s0');
      expect(job.descriptionRef).toBe(PATHS.jobDescription(id));
      const description = await db.doc(job.descriptionRef).get();
      expect(JobDescriptionSchema.safeParse(timestampsToDates(description.data())).success).toBe(
        true,
      );
    }

    const run = RunSchema.parse(
      timestampsToDates((await db.doc(PATHS.run(result.runId)).get()).data()),
    );
    expect(run).toMatchObject({ status: 'partial', perStage: { s0: result.s0 } });

    const adzuna = SourceHealthSchema.parse(
      timestampsToDates((await db.doc(PATHS.source('adzuna')).get()).data()),
    );
    expect(adzuna.quota?.dayCount).toBeGreaterThan(0);

    const gone = CompanySchema.parse(
      timestampsToDates((await db.doc(PATHS.company('echo-gone')).get()).data()),
    );
    expect(gone.lastScan).toMatchObject({
      status: 'not_found',
      consecutiveFailures: 1,
      broken: false,
    });
    expect((await db.collection(COLLECTIONS.companies).get()).size).toBe(FAKE_SEED.length);

    // Board rotation reads when each board was last fetched (ADR-029).
    const watched = await firestoreScanStore(db).watchedCompanies();
    const acme = watched.find((entry) => entry.company.id === 'acme-analytics');
    expect(acme?.company.lastScannedAt).toEqual(T0);
  });

  it('writes no job on a second run over the same postings', async () => {
    await runScan(deps(T0));
    const before = await allJobs();
    const second = await runScan(deps(minutes(10)));
    if (second.status !== 'completed') throw new Error(second.status);
    expect(second.s0).toMatchObject({ new: 0, merged: 0 });
    const after = await allJobs();
    expect(after.map((j) => [j.id, j.updateTime])).toEqual(before.map((j) => [j.id, j.updateTime]));
  });

  it('adds the Greenhouse source to a stored LinkedIn-alert job instead of a new job (R5)', async () => {
    const alert = normaliseRawJob(LINKEDIN_ALERT_JOB);
    const [group] = dedupeBatch(alert ? [alert] : []);
    if (!group) throw new Error('fixture');
    const ref = db.collection(COLLECTIONS.jobs).doc('linkedin-job');
    const { job, description } = buildNewJob(group, PATHS.jobDescription(ref.id), minutes(-60));
    await ref.set(job);
    await db.doc(PATHS.jobDescription(ref.id)).set(description);

    await runScan(deps(T0));
    const stored = JobSchema.parse(timestampsToDates((await ref.get()).data()));
    expect(stored.sources.map((source) => source.id).sort()).toEqual([
      'adzuna',
      'greenhouse',
      'hn',
      'linkedin-alert',
    ]);
    expect(stored.keys).toEqual(
      expect.arrayContaining(['greenhouse:5551234', 'linkedin:4012345678']),
    );
    const acme = (await allJobs()).filter(
      ({ job: j }) => j.company.startsWith('Acme') && j.title === 'Product Analyst',
    );
    expect(acme.map(({ id }) => id)).toEqual(['linkedin-job']);
  });

  it('refuses a scan while one runs, takes over a stale lock, and applies the cooldown', async () => {
    await db.doc(DOCS.scanLock).set({ runId: 'other', startedAt: T0, schemaVersion: 1 });
    await expect(runScan(deps(minutes(5)))).resolves.toEqual({ status: 'busy' });

    // 13 minutes later the lock is stale: the dead scan never released it.
    const taken = await runScan(deps(minutes(13)));
    expect(taken.status).toBe('completed');
    const lock = (await db.doc(DOCS.scanLock).get()).data();
    expect(lock).not.toHaveProperty('runId');

    const soon = await runScan(deps(minutes(14)));
    expect(soon).toMatchObject({ status: 'skipped_recent', retryAfterSeconds: 240 });
    expect((await runScan(deps(minutes(19)))).status).toBe('completed');
  });

  it('never overwrites an existing company from the seed', async () => {
    await db.doc(PATHS.company('acme-analytics')).set({
      name: 'Acme Analytics',
      domain: 'acme-analytics.example.com',
      ats: { type: 'greenhouse', token: 'acmeanalytics' },
      hq: 'London',
      watch: false,
      origin: 'seed',
      createdAt: minutes(-1000),
      updatedAt: minutes(-1000),
      schemaVersion: 1,
    });
    const result = await runScan(deps(T0));
    if (result.status !== 'completed') throw new Error(result.status);
    const acme = (await db.doc(PATHS.company('acme-analytics')).get()).data();
    expect(acme?.watch).toBe(false);
    // Unwatched: its board isn't fetched.
    expect(result.perSource.greenhouse).toMatchObject({ fetched: 0 });
  });
});
