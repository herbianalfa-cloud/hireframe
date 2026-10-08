/**
 * Lookup against the Firestore emulator with the real stores and the fake model (ADR-049). Run
 * with `npm run test:rules`. Proves: the precondition transaction drops a write when the job
 * moved; the claim is taken once; a board posting attaches atomically; user-added jobs are read
 * first through the new query; the daily Lookup cap holds under concurrency and rolls over at
 * London midnight; `add` end to end writes jobs that parse against the shared schemas and leaves
 * the lock free; and a LinkedIn job ingested from an alert email is found by every URL form
 * (PRD R8, by ID).
 */
import {
  COLLECTIONS,
  CRITERIA_SEED_V1,
  DOCS,
  JobDescriptionSchema,
  JobSchema,
  parseLookupInput,
  PATHS,
  ScanLockSchema,
  UsageSchema,
  type CriteriaVersion,
  type IngestMessage,
  type Job,
} from '@hireframe/shared';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LINKEDIN_ALERT } from '../../packages/shared/src/fixtures/alerts.js';
import { FAKE_CV_EXTRACTION } from '../../functions/src/fixtures/fake-cv-response.js';
import { planAttachment } from '../../functions/src/funnel/attach.js';
import { s1PassPatch } from '../../functions/src/funnel/judgement.js';
import { jobsByKeysSpec } from '../../functions/src/funnel/queries.js';
import { firestoreFunnelStore } from '../../functions/src/funnel/store.js';
import { runIngest } from '../../functions/src/ingest/run.js';
import { firestoreIngestStore } from '../../functions/src/ingest/store.js';
import { DailyCapExceededError } from '../../functions/src/llm/errors.js';
import { fakeTransport } from '../../functions/src/llm/fake-transport.js';
import { dailyCapped, firestoreUsageStore } from '../../functions/src/llm/usage-store.js';
import { createAtsSearch } from '../../functions/src/lookup/ats-search.js';
import { runAdd, runDescribe, type LookupDeps } from '../../functions/src/lookup/run.js';
import { firestoreLookupStore } from '../../functions/src/lookup/store.js';
import { firestoreScanStore } from '../../functions/src/scan/store.js';
import { FAKE_SEED } from '../../functions/src/sources/fixtures.js';
import { testHttpClient } from '../../functions/src/sources/testing.js';
import { normaliseRawJob } from '@hireframe/shared';
import { timestampsToDates } from '../../functions/src/timestamps.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

let app: App;
let db: Firestore;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run with `npm run test:rules`.');
  app = initializeApp({ projectId: 'demo-hireframe' }, 'lookup-test');
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

const criteria: CriteriaVersion = {
  ...CRITERIA_SEED_V1,
  version: 1,
  createdAt: daysAgo(10),
  schemaVersion: 1,
};

beforeEach(async () => {
  for (const path of [
    COLLECTIONS.jobs,
    COLLECTIONS.usage,
    COLLECTIONS.profile,
    COLLECTIONS.companies,
    COLLECTIONS.sources,
    'locks',
    'alertMessages',
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
  for (const seed of FAKE_SEED) {
    batch.set(db.doc(PATHS.company(seed.id)), {
      name: seed.name,
      domain: seed.domain,
      ats: seed.ats,
      hq: seed.hq,
      origin: 'seed',
      watch: true,
      createdAt: daysAgo(30),
      updatedAt: daysAgo(30),
      schemaVersion: 1,
    });
  }
  batch.set(db.doc(PATHS.company('not-watched')), {
    name: 'Zed Unwatched',
    domain: 'zed.example.com',
    ats: { type: 'greenhouse', token: 'zed' },
    hq: 'London',
    origin: 'manual',
    watch: false,
    createdAt: daysAgo(30),
    updatedAt: daysAgo(30),
    schemaVersion: 1,
  });
  await batch.commit();
});

function job(id: string, patch: Partial<Job> = {}): Job {
  return {
    dedupeKey: `d:${id}`,
    keys: [`d:${id}`],
    title: 'Product Analyst',
    company: 'Acme Analytics',
    location: 'London',
    city: 'london',
    country: 'GB',
    remote: 'hybrid',
    url: `https://jobs.example.com/${id}`,
    sources: [
      {
        id: 'linkedin-alert',
        url: `https://jobs.example.com/${id}`,
        externalId: id,
        seenAt: daysAgo(1),
      },
    ],
    firstSeenAt: daysAgo(1),
    descriptionRef: PATHS.jobDescription(id),
    descriptionKind: 'none',
    stage: 's2',
    status: 'new',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    schemaVersion: 1,
    ...patch,
  };
}

async function put(id: string, patch: Partial<Job> = {}, text = ''): Promise<void> {
  const value = job(id, patch);
  await db.doc(PATHS.job(id)).set(value);
  await db.doc(PATHS.jobDescription(id)).set({
    text,
    kind: value.descriptionKind,
    sourceId: 'linkedin-alert',
    fetchedAt: daysAgo(1),
    schemaVersion: 1,
  });
}

async function read(id: string): Promise<Job> {
  return JobSchema.parse(timestampsToDates((await db.doc(PATHS.job(id)).get()).data()));
}

function deps(patch: Partial<LookupDeps> = {}): LookupDeps {
  const funnel = firestoreFunnelStore(db);
  return {
    scan: firestoreScanStore(db),
    store: firestoreLookupStore(db),
    funnel,
    readCriteria: () => Promise.resolve(criteria),
    llm: {
      transport: fakeTransport(),
      usage: dailyCapped(firestoreUsageStore(db), 'lookup', 25),
      capPence: 1_500,
      fxUsdToGbp: 0.85,
      now: () => NOW,
      newId: (() => {
        let n = 0;
        return () => `lookup-${String((n += 1))}`;
      })(),
    },
    ats: createAtsSearch({
      http: testHttpClient(),
      watched: () => funnel.watchedCompanies(),
      maxBoards: 12,
    }),
    now: () => NOW,
    clock: () => NOW.getTime(),
    sleep: () => Promise.resolve(),
    startedAtMs: NOW.getTime(),
    ...patch,
  };
}

describe('the lookup store on the emulator', () => {
  it('commits only while the job is where Lookup left it', async () => {
    await put('j1', { stage: 's1', next: 's2' });
    const store = firestoreLookupStore(db);
    const patch = { set: { next: 'description' as const }, clear: [] };
    // A scan judged it in between: stage moved on.
    await db
      .doc(PATHS.job('j1'))
      .update({ stage: 's3', next: null, judgedAt: NOW, verdict: 'apply' });
    expect(await store.commit('j1', { stage: 's1', next: 's2' }, { patch }, NOW)).toBe('dropped');
    expect(await read('j1')).toMatchObject({ stage: 's3', verdict: 'apply', next: null });
    // Where it is now, the same write goes through.
    expect(
      await store.commit('j1', { stage: 's3', next: null, judgedAt: NOW }, { patch }, NOW),
    ).toBe('applied');
    expect(await store.commit('nope', { stage: 's1', next: 's2' }, { patch }, NOW)).toBe('missing');
  });

  it('lets exactly one of two concurrent writes through', async () => {
    await put('j1', { stage: 's1', next: 's2' });
    const store = firestoreLookupStore(db);
    const results = await Promise.all(
      ['a', 'b'].map((who) =>
        store.commit(
          'j1',
          { stage: 's1', next: 's2' },
          { patch: { set: { reason: who, next: null }, clear: [] } },
          NOW,
        ),
      ),
    );
    expect([...results].sort()).toEqual(['applied', 'dropped']);
  });

  it('claims a waiting job once, and takes over only a dead claim', async () => {
    await put('w1', { stage: 's2', next: 'description' });
    const store = firestoreLookupStore(db);
    const claimed = await store.claimDescription('w1', NOW, 600_000);
    expect(claimed).toMatchObject({ next: null, describingAt: NOW });
    expect(await read('w1')).toMatchObject({ next: null, describingAt: NOW });
    expect(await store.claimDescription('w1', NOW, 600_000)).toBeNull();
    const later = new Date(NOW.getTime() + 601_000);
    expect(await store.claimDescription('w1', later, 600_000)).not.toBeNull();
    await put('done', { stage: 's3', next: null, verdict: 'apply', judgedAt: NOW });
    expect(await store.claimDescription('done', NOW, 600_000)).toBeNull();
  });

  it('attaches a board posting in one transaction: text, source, keys, date, company', async () => {
    await put('a1', { stage: 's1', next: 's2', keys: ['linkedin:4012345678', 'd:acme'] });
    const posting = normaliseRawJob({
      sourceId: 'greenhouse',
      externalId: '5551234',
      url: 'https://job-boards.greenhouse.io/acmeanalytics/jobs/5551234',
      title: 'Product Analyst',
      company: 'Acme Analytics',
      locationText: 'London, UK',
      postedAt: daysAgo(9),
      description: { kind: 'full', format: 'text', body: 'The full posting text of the role.' },
    });
    if (!posting) throw new Error('fixture');
    const before = await read('a1');
    const attach = planAttachment(before, posting, NOW);
    const store = firestoreLookupStore(db);
    const result = await store.commit(
      'a1',
      { stage: 's1', next: 's2' },
      {
        patch: s1PassPatch({ flags: [], sortAt: NOW }),
        attach,
        companyId: 'acme-analytics',
        describingAt: 'clear',
      },
      NOW,
    );
    expect(result).toBe('applied');
    const after = await read('a1');
    expect(after.sources.map((source) => source.id)).toEqual(['linkedin-alert', 'greenhouse']);
    expect(after.keys).toEqual(
      expect.arrayContaining(['linkedin:4012345678', 'greenhouse:5551234']),
    );
    expect(after).toMatchObject({ descriptionKind: 'full', companyId: 'acme-analytics' });
    expect(after.postedAt).toEqual(daysAgo(9));
    const description = JobDescriptionSchema.parse(
      timestampsToDates((await db.doc(PATHS.jobDescription('a1')).get()).data()),
    );
    expect(description).toMatchObject({ kind: 'full', sourceId: 'greenhouse' });
  });
});

describe('queries (ADR-049)', () => {
  it('reads user-added jobs first, newest addedAt first, and only those', async () => {
    await put('plain', { stage: 's1', next: 's2', sortAt: NOW });
    await put('old', { stage: 's1', next: 's2', sortAt: daysAgo(3), addedAt: daysAgo(2) });
    await put('new', { stage: 's1', next: 's2', sortAt: daysAgo(4), addedAt: daysAgo(1) });
    await put('s3', { stage: 's2', next: 's3', addedAt: daysAgo(1) });
    const store = firestoreFunnelStore(db);
    expect((await store.queuedAdded('s2', 10)).map((entry) => entry.id)).toEqual(['new', 'old']);
    expect((await store.queuedAdded('s3', 10)).map((entry) => entry.id)).toEqual(['s3']);
    expect(await store.queuedAdded('s2', 0)).toEqual([]);
  });

  it('reads watched companies that have a board, and no others', async () => {
    const watched = await firestoreFunnelStore(db).watchedCompanies();
    expect(watched.map((company) => company.id).sort()).toEqual(
      FAKE_SEED.filter((seed) => seed.ats.type !== 'none')
        .map((seed) => seed.id)
        .sort(),
    );
  });
});

describe('the daily Lookup cap on the emulator (ADR-047)', () => {
  const settle = (store: ReturnType<typeof dailyCapped>, id: string, at: Date, cost: number) =>
    store.settle({
      month: '2026-10',
      id,
      now: at,
      model: 'claude-haiku-4-5',
      purpose: 'triage',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      costPence: cost,
    });

  it('lets two of three concurrent 10p reservations through under a 25p cap', async () => {
    const store = dailyCapped(firestoreUsageStore(db), 'lookup', 25);
    const results = await Promise.allSettled(
      ['lookup-a', 'lookup-b', 'lookup-c'].map((id) =>
        store.reserve({ month: '2026-10', id, pence: 10, capPence: 1_500, now: NOW }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused?.status === 'rejected' && refused.reason).toBeInstanceOf(DailyCapExceededError);
  });

  it('adds settled spend to today and starts a new day at London midnight', async () => {
    const store = dailyCapped(firestoreUsageStore(db), 'lookup', 25);
    const evening = new Date('2026-10-14T22:30:00Z'); // 23:30 BST on the 14th
    await store.reserve({
      month: '2026-10',
      id: 'lookup-1',
      pence: 20,
      capPence: 1_500,
      now: evening,
    });
    await settle(store, 'lookup-1', evening, 20);
    await expect(
      store.reserve({ month: '2026-10', id: 'lookup-2', pence: 10, capPence: 1_500, now: evening }),
    ).rejects.toBeInstanceOf(DailyCapExceededError);
    const after = new Date('2026-10-14T23:30:00Z'); // 00:30 BST on the 15th
    await store.reserve({
      month: '2026-10',
      id: 'lookup-3',
      pence: 10,
      capPence: 1_500,
      now: after,
    });
    const usage = UsageSchema.parse(
      timestampsToDates((await db.doc(PATHS.usage('2026-10')).get()).data()),
    );
    expect(usage.daily?.lookup).toMatchObject({ day: '2026-10-14', spendPence: 20 });
  });
});

describe('add and describe end to end', () => {
  it('judges a job from a board posting with real stores, and leaves the lock free', async () => {
    const result = await runAdd(deps(), [
      {
        kind: 'row',
        title: 'Product Analyst',
        company: 'Acme Analytics',
        location: 'London, England, United Kingdom',
        linkedinId: '4012345678',
        age: '2 days ago',
      },
      { kind: 'row', title: 'Warehouse Operative', company: 'Nobody Ltd', location: 'Leeds' },
      { kind: 'row', title: 'Senior Product Analyst', company: 'Nobody Ltd', location: 'Leeds' },
    ]);
    if (result.status !== 'done') throw new Error('expected done');
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      'judged',
      'skipped',
      'skipped',
    ]);
    const first = result.outcomes[0];
    const id = first && 'jobId' in first ? first.jobId : '';
    expect(await read(id)).toMatchObject({
      verdict: 'apply',
      stage: 's3',
      next: null,
      addedAt: NOW,
      companyId: 'acme-analytics',
    });
    expect((await read(id)).flags).toContain('posted_estimated');
    // The lock was held as `lookup` and released without starting a scan cooldown.
    const lock = ScanLockSchema.parse(
      timestampsToDates((await db.doc(DOCS.scanLock).get()).data()),
    );
    expect(lock.runId).toBeUndefined();
    expect(lock.lastFinishedAt).toBeUndefined();
    // Usage: every call was under the daily cap, tracked by day, with a Lookup purpose.
    const usage = UsageSchema.parse(
      timestampsToDates((await db.doc(PATHS.usage('2026-10')).get()).data()),
    );
    expect(Object.keys(usage.reservations)).toHaveLength(0);
    expect(usage.daily?.lookup?.spendPence).toBeGreaterThan(0);
  });

  it('describes a waiting job and writes the verdict, clearing the claim', async () => {
    await put('w1', {
      stage: 's2',
      next: 'description',
      flags: ['needs_description'],
      triage: {
        lane: 'primary',
        seniority: 'junior',
        blockers: [],
        pass: true,
        triageScore: 7,
        note: 'A fit.',
      },
    });
    const result = await runDescribe(
      deps(),
      'w1',
      'Acme Analytics is hiring a Product Analyst to own the weekly metrics review, turn product questions into SQL and explain the results to product managers.',
    );
    expect(result).toEqual({ status: 'judged', verdict: 'apply' });
    const stored = await read('w1');
    expect(stored).toMatchObject({ verdict: 'apply', next: null, descriptionKind: 'full' });
    expect(stored.describingAt).toBeUndefined();
    const description = JobDescriptionSchema.parse(
      timestampsToDates((await db.doc(PATHS.jobDescription('w1')).get()).data()),
    );
    expect(description).toMatchObject({ kind: 'full', sourceId: 'lookup' });
  });
});

describe('R8 by ID: a LinkedIn alert job is found by every URL form', () => {
  const message = (): IngestMessage => ({
    id: 'alert-r8',
    receivedAt: NOW.toISOString(),
    ...LINKEDIN_ALERT,
  });

  it('matches /jobs/view/{id}, its tracking, comm and slugged forms to the ingested job', async () => {
    await runIngest(
      {
        store: firestoreIngestStore(db),
        parseWithModel: () => Promise.reject(new Error('LinkedIn alerts need no model')),
        now: () => NOW,
        clock: () => NOW.getTime(),
      },
      [message()],
    );
    const forms = [
      'https://www.linkedin.com/jobs/view/4012345678/',
      'https://www.linkedin.com/jobs/view/4012345678/?trackingId=x&refId=y',
      'https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=x',
      'https://www.linkedin.com/jobs/view/product-analyst-at-acme-analytics-4012345678',
      'https://www.linkedin.com/jobs/search/?keywords=a&currentJobId=4012345678',
    ];
    for (const form of forms) {
      const [target] = parseLookupInput(form);
      const spec = jobsByKeysSpec(target?.keys ?? []);
      const snapshot = await db
        .collection(spec.collection)
        .where('keys', 'array-contains-any', target?.keys ?? [])
        .get();
      expect(snapshot.docs, form).toHaveLength(1);
      expect(JobSchema.parse(timestampsToDates(snapshot.docs[0]?.data()))).toMatchObject({
        stage: 's0',
        status: 'new',
      });
      // And by canonical URL, the way the browser's second query matches a job with no key.
      const byUrl = await db.collection('jobs').where('url', '==', target?.url).get();
      expect(byUrl.docs, form).toHaveLength(form.includes('currentJobId') ? 0 : 1);
    }
    // Lookup would not add it again.
    const result = await runAdd(deps(), [
      {
        kind: 'row',
        title: 'Product Analyst',
        company: 'Acme Analytics',
        location: 'London',
        linkedinId: '4012345678',
      },
    ]);
    if (result.status !== 'done') throw new Error('expected done');
    expect(result.outcomes[0]?.status).toBe('seen');
    // The alert's five jobs, and nothing new.
    expect((await db.collection('jobs').get()).size).toBe(5);
  });
});
