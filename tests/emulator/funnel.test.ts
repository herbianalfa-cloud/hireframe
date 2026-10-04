/**
 * The funnel against the Firestore emulator with the real stores and the fake model (ADR-032–037).
 * Run with `npm run test:rules`. Proves: s0 jobs get verdicts with Timestamps and deleted fields
 * handled by Firestore; the run's lease is reserved and settled on usage/{month} with no
 * reservation left; queued jobs are read in order; the profile's work rights reach S1; Reed full
 * text replaces a snippet; a re-score keeps the old verdict while a job is queued.
 */
import {
  COLLECTIONS,
  CRITERIA_SEED_V1,
  DOCS,
  JobDescriptionSchema,
  JobSchema,
  monthKey,
  PATHS,
  UsageSchema,
  type CriteriaVersion,
  type Job,
} from '@hireframe/shared';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { funnelLimits } from '../../functions/src/config.js';
import { FAKE_CV_EXTRACTION } from '../../functions/src/fixtures/fake-cv-response.js';
import { createReedHydrator } from '../../functions/src/funnel/hydrate.js';
import { runFunnel, type FunnelDeps } from '../../functions/src/funnel/run.js';
import { firestoreFunnelStore } from '../../functions/src/funnel/store.js';
import { fakeTransport } from '../../functions/src/llm/fake-transport.js';
import { firestoreUsageStore } from '../../functions/src/llm/usage-store.js';
import { testHttpClient } from '../../functions/src/sources/testing.js';
import { timestampsToDates } from '../../functions/src/timestamps.js';

const NOW = new Date('2026-10-05T08:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

let app: App;
let db: Firestore;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run with `npm run test:rules`.');
  app = initializeApp({ projectId: 'demo-hireframe' }, 'funnel-test');
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

const criteria = (patch: Partial<CriteriaVersion> = {}): CriteriaVersion => ({
  ...CRITERIA_SEED_V1,
  version: 1,
  createdAt: daysAgo(10),
  schemaVersion: 1,
  ...patch,
});

function job(id: string, patch: Partial<Job> = {}): Job {
  return {
    dedupeKey: `d:${id}`,
    keys: [`d:${id}`],
    title: 'Product Analyst',
    company: 'Northwind Ledger',
    location: 'London',
    city: 'london',
    country: 'GB',
    remote: 'hybrid',
    url: `https://jobs.example.com/${id}`,
    sources: [
      {
        id: 'greenhouse',
        url: `https://jobs.example.com/${id}`,
        externalId: id,
        seenAt: daysAgo(1),
      },
    ],
    postedAt: daysAgo(2),
    firstSeenAt: daysAgo(1),
    descriptionRef: PATHS.jobDescription(id),
    descriptionKind: 'full',
    stage: 's0',
    status: 'new',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    schemaVersion: 1,
    ...patch,
  };
}

async function addJob(id: string, patch: Partial<Job> = {}, text = 'Help the product team.') {
  const value = job(id, patch);
  await db.doc(PATHS.job(id)).set(value);
  await db.doc(PATHS.jobDescription(id)).set({
    text,
    kind: value.descriptionKind,
    sourceId: value.sources[0]?.id ?? 'greenhouse',
    fetchedAt: daysAgo(1),
    schemaVersion: 1,
  });
}

async function read(id: string): Promise<Job> {
  return JobSchema.parse(timestampsToDates((await db.doc(PATHS.job(id)).get()).data()));
}

function deps(patch: Partial<FunnelDeps> = {}): FunnelDeps {
  return {
    store: firestoreFunnelStore(db),
    leases: firestoreUsageStore(db),
    transport: fakeTransport(),
    fxUsdToGbp: 0.85,
    monthlyCapPence: 1_500,
    limits: funnelLimits(1_500, {}),
    criteria: criteria(),
    hydrator: null,
    now: () => NOW,
    clock: () => NOW.getTime(),
    sleep: () => Promise.resolve(),
    startedAtMs: NOW.getTime(),
    ...patch,
  };
}

beforeEach(async () => {
  for (const path of [
    COLLECTIONS.jobs,
    COLLECTIONS.usage,
    COLLECTIONS.profile,
    COLLECTIONS.sources,
  ]) {
    await db.recursiveDelete(db.collection(path));
  }
  const batch = db.batch();
  FAKE_CV_EXTRACTION.facts.forEach((fact, index) => {
    batch.set(db.doc(PATHS.fact(`fact-${String(index).padStart(3, '0')}`)), {
      ...fact,
      source: 'cv',
      status: 'active',
      version: 1,
      evidenceVerified: true,
      createdAt: daysAgo(30),
      updatedAt: daysAgo(30),
      schemaVersion: 1,
    });
  });
  batch.set(db.doc(DOCS.profileMain), {
    workRights: 'time_limited',
    createdAt: daysAgo(30),
    updatedAt: daysAgo(30),
    schemaVersion: 1,
  });
  await batch.commit();
});

describe('the funnel on the emulator', () => {
  it('judges s0 jobs and settles the run lease', async () => {
    await addJob('apply');
    await addJob('senior', { title: 'Senior Product Analyst' });
    await addJob('rtw', {}, 'Applicants must have indefinite leave to remain.');
    const result = await runFunnel(deps(), { runId: 'r1' });

    expect(await read('apply')).toMatchObject({
      verdict: 'apply',
      stage: 's3',
      next: null,
      criteriaVersion: 1,
    });
    expect((await read('apply')).matchedFactIds?.length).toBeGreaterThan(0);
    expect(await read('senior')).toMatchObject({ skip: { stage: 's1', ruleId: 'title:senior' } });
    expect(await read('rtw')).toMatchObject({ skip: { ruleId: 'blocker:right-to-work' } });
    expect(result.summary.queued).toEqual({ s2: 0, s3: 0 });

    const usage = UsageSchema.parse(
      timestampsToDates((await db.doc(PATHS.usage(monthKey(NOW))).get()).data()),
    );
    expect(usage.reservations).toEqual({});
    expect(usage.spendPence).toBeCloseTo(result.costPence, 4);
    expect(usage.calls['fake:claude-haiku-4-5']).toBe(1);
    expect(usage.calls['fake:claude-sonnet-5-5']).toBe(1);
  });

  it('clears an old verdict when S1 now skips, and keeps it while a job waits (re-score)', async () => {
    await addJob('a');
    await addJob('b', { title: 'Technical Account Manager' });
    await runFunnel(deps(), { runId: 'r1' });
    expect((await read('a')).fitScore).toBeDefined();

    const changed = criteria({
      version: 2,
      excluded_companies: ['Northwind Ledger'],
      wildcards: ['sales engineering'],
    });
    await db.doc(PATHS.job('b')).update({ company: 'Other Co' });
    const late = NOW.getTime() - 450_000;
    await runFunnel(deps({ criteria: changed, startedAtMs: late }), {
      runId: 'r2',
      rescoreSince: daysAgo(14),
    });
    const a = await read('a');
    expect(a).toMatchObject({
      verdict: 'skip',
      skip: { ruleId: 'company' },
      criteriaVersion: 2,
    });
    expect(a.fitScore).toBeUndefined();
    expect(a.deep).toBeUndefined();
    const b = await read('b');
    expect(b).toMatchObject({ verdict: 'near_miss', next: 's2', criteriaVersion: 1 });
    expect(b.rescoreQueuedAt).toBeInstanceOf(Date);
  });

  it('expires a stale queued job below the read limit as a freshness skip', async () => {
    const stale = { stage: 's1' as const, next: 's2' as const, sortAt: daysAgo(20) };
    await addJob('fresh', { stage: 's1', next: 's2', sortAt: daysAgo(1) });
    await addJob('stale-a', { ...stale, postedAt: daysAgo(20) });
    await addJob('stale-b', { ...stale, sortAt: daysAgo(30), postedAt: daysAgo(30) });
    const result = await runFunnel(deps({ limits: { ...funnelLimits(1_500, {}), s2MaxJobs: 1 } }), {
      runId: 'r1',
    });
    for (const id of ['stale-a', 'stale-b']) {
      expect(await read(id)).toMatchObject({
        verdict: 'skip',
        stage: 's2',
        skip: { stage: 's2', ruleId: 'freshness' },
        next: null,
      });
    }
    expect((await read('fresh')).verdict).toBe('apply');
    expect(result.perStage.s2.expired).toBe(2);
  });

  it('reads queued S3 jobs best triage first', async () => {
    const triage = (score: number) => ({
      lane: 'primary' as const,
      seniority: 'junior' as const,
      blockers: [],
      pass: true,
      triageScore: score,
      note: 'ok',
    });
    await addJob('low', { stage: 's2', next: 's3', sortAt: daysAgo(1), triage: triage(5) });
    await addJob('high', { stage: 's2', next: 's3', sortAt: daysAgo(3), triage: triage(9) });
    await addJob('s2', { stage: 's1', next: 's2', sortAt: daysAgo(1) });
    const store = firestoreFunnelStore(db);
    expect((await store.queued('s3', 10)).map((entry) => entry.id)).toEqual(['high', 'low']);
    expect((await store.queued('s2', 10)).map((entry) => entry.id)).toEqual(['s2']);
    expect(await store.queueCounts()).toEqual({ s2: 1, s3: 2 });
  });

  it('replaces a Reed snippet with full text before S3', async () => {
    await addJob(
      'reed',
      {
        descriptionKind: 'snippet',
        sources: [
          {
            id: 'reed',
            url: 'https://www.reed.co.uk/jobs/x/50005678',
            externalId: '50005678',
            seenAt: daysAgo(1),
          },
        ],
      },
      'Short snippet.',
    );
    const store = firestoreFunnelStore(db);
    const hydrator = createReedHydrator({
      http: testHttpClient(),
      apiKey: 'fake',
      perRun: 20,
      readQuota: () => store.reedQuota(),
      saveQuota: (quota) => store.saveReedQuota(quota),
      saveFullText: (jobId, text, now) => store.saveFullText(jobId, text, now),
      now: () => NOW,
    });
    await runFunnel(deps({ hydrator }), { runId: 'r1' });
    const saved = JobDescriptionSchema.parse(
      timestampsToDates((await db.doc(PATHS.jobDescription('reed')).get()).data()),
    );
    expect(saved).toMatchObject({ kind: 'full', sourceId: 'reed' });
    expect(saved.text).toContain('Build dashboards in SQL');
    const reed = await read('reed');
    expect(reed).toMatchObject({ descriptionKind: 'full', verdict: 'apply' });
    expect(reed.flags ?? []).not.toContain('snippet_only');
    expect((await db.doc(PATHS.source('reed')).get()).get('quota.dayCount')).toBe(1);
  });
});
