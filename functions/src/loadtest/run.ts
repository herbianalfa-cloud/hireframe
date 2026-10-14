import {
  AppConfigSchema,
  CRITERIA_SEED_V1,
  DOCS,
  PATHS,
  SCAN_SOURCE_IDS,
  dedupeBatch,
  monthKey,
  normaliseRawJob,
  planIngest,
  type RawJob,
} from '@hireframe/shared';
import { type Firestore } from 'firebase-admin/firestore';

import { bucket as adminBucket, db as adminDb } from '../admin.js';
import { FAKE_CV_EXTRACTION } from '../fixtures/fake-cv-response.js';
import { FUNNEL } from '../config.js';
import { fakeTriage } from '../funnel/fake-answers.js';
import { needsDescriptionPatch, s1PassPatch, s2PassPatch } from '../funnel/judgement.js';
import { firestoreFunnelStore } from '../funnel/store.js';
import type { FunnelOutcome, FunnelProbe, ProbeMark } from '../funnel/run.js';
import { funnelFor } from '../funnel/wiring.js';
import { scanHttpClient } from '../http/scan-client.js';
import { fakeTransport } from '../llm/fake-transport.js';
import { bucketFileDeleter, firestoreResetStore } from '../profile/store.js';
import { firestoreScanStore } from '../scan/store.js';
import { runScan, type ScanDeps } from '../scan/run.js';
import { createSources } from '../sources/index.js';
import { deleteAllDataHandler } from '../wipe/run.js';
import { firestoreWipeStore } from '../wipe/store.js';
import { counted, newCounters, type Counters } from './counting.js';
import { buildLoadData, LOAD_DEFAULTS, prng, type LoadData } from './data.js';
import { assertLoadTestEnvironment } from './environment.js';
import { loadFetch, type FetchRecord } from './fetch.js';
import { evaluate, formatTable, type Check, type Measurements, type WipeCall } from './report.js';
import { loadTransport } from './transport.js';

/**
 * The load test (`node scripts/load-test.ts`, plan B4): a 1,000-job run against the emulator
 * with fake data, the real scan, funnel, HTTP client and wipe core, and real deadlines. It
 * answers ADR-032's open question: do 32 S3 calls fit inside 450 s? Never imported by
 * `index.ts`, so it is not in the deploy bundle. Refuses LIVE=1 and any project not `demo-*`.
 */
export interface LoadTestOptions {
  jobs: number;
  s1Passes: number;
}

const MONTHLY_CAP_PENCE = 3_200;

async function seedBasics(db: Firestore, now: Date): Promise<void> {
  const batch = db.batch();
  batch.set(db.doc(DOCS.appConfig), {
    ownerUid: 'owner-load',
    schemaVersion: 1,
    monthlyCapPence: MONTHLY_CAP_PENCE,
    createdAt: now,
    updatedAt: now,
  });
  batch.set(db.doc(PATHS.criteriaVersion('v1')), {
    ...CRITERIA_SEED_V1,
    version: 1,
    createdAt: now,
    schemaVersion: 1,
  });
  batch.set(db.doc(DOCS.criteriaCurrent), { version: 1, updatedAt: now, schemaVersion: 1 });
  batch.set(db.doc(DOCS.profileMain), {
    workRights: 'time_limited',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  });
  FAKE_CV_EXTRACTION.facts.forEach((draft, index) => {
    const id = `load-fact-${String(index + 1).padStart(3, '0')}`;
    batch.set(db.doc(PATHS.fact(id)), {
      ...draft,
      source: 'cv',
      status: 'active',
      version: 1,
      evidenceVerified: true,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
  });
  await batch.commit();
}

/** Alerts and stale queued jobs, written as ingest would and put into their queue states. */
async function seedQueuedJobs(db: Firestore, data: LoadData, now: Date): Promise<void> {
  const scanStore = firestoreScanStore(db);
  const funnelStore = firestoreFunnelStore(db);
  const raws: { raw: RawJob; state: 'alert' | 's2' | 's3' | 'description' }[] = [
    ...data.alerts.map((raw) => ({ raw, state: 'alert' as const })),
    ...data.stale.map(({ raw, state }) => ({ raw, state })),
  ];
  const normalised = raws.flatMap(({ raw, state }) => {
    const job = normaliseRawJob(raw);
    return job ? [{ job, state, raw }] : [];
  });
  const groups = dedupeBatch(normalised.map((entry) => entry.job));
  const plan = planIngest(groups, [], { minUpgradeChars: FUNNEL.minDeepReadChars });
  const written = await scanStore.writePlan(plan, now);
  if (written.failedWrites > 0)
    throw new Error(`Seeding failed: ${String(written.failedWrites)} writes`);

  const found = await scanStore.findJobsByKeys(normalised.map((entry) => entry.job.sourceKey));
  const idByKey = new Map(found.flatMap((job) => job.keys.map((key) => [key, job.id] as const)));
  const updates: { jobId: string; patch: ReturnType<typeof s1PassPatch> }[] = [];
  for (const { job, state, raw } of normalised) {
    const jobId = idByKey.get(job.sourceKey);
    if (!jobId) throw new Error(`Seeded job not found: ${raw.title}`);
    const sortAt = raw.postedAt ?? now;
    const s1 = s1PassPatch({ flags: [], sortAt });
    if (state === 's2') {
      updates.push({ jobId, patch: s1 });
      continue;
    }
    const triage = {
      ...fakeTriage(`Title: ${raw.title}`),
      pass: true,
      triageScore: state === 'alert' ? 9 : 7,
    };
    const s2 = s2PassPatch({ triage, fingerprint: 'a'.repeat(64), costPence: 0 }, {});
    const merged = { set: { ...s1.set, ...s2.set }, clear: [] as typeof s1.clear };
    updates.push({
      jobId,
      patch:
        state === 'description'
          ? { set: { ...merged.set, ...needsDescriptionPatch({}).set }, clear: [] }
          : merged,
    });
  }
  const failed = await funnelStore.apply(updates, now);
  if (failed > 0) throw new Error(`Seeding queue states failed: ${String(failed)}`);
}

interface JobSnapshot {
  jobs: Map<string, { sources: number; keys: number }>;
  descriptions: number;
}

async function snapshotJobs(db: Firestore): Promise<JobSnapshot> {
  const [jobs, descriptions] = await Promise.all([
    db.collection('jobs').select('sources', 'keys').get(),
    db.collectionGroup('description').select().get(),
  ]);
  return {
    jobs: new Map(
      jobs.docs.map((doc) => {
        const data = doc.data() as { sources?: unknown[]; keys?: unknown[] };
        return [doc.id, { sources: data.sources?.length ?? 0, keys: data.keys?.length ?? 0 }];
      }),
    ),
    descriptions: descriptions.size,
  };
}

/** Compares two snapshots: jobs created, and jobs whose sources or keys changed. */
export function diffSnapshots(before: JobSnapshot, after: JobSnapshot) {
  let created = 0;
  let changed = 0;
  for (const [id, now] of after.jobs) {
    const was = before.jobs.get(id);
    if (!was) created += 1;
    else if (was.sources !== now.sources || was.keys !== now.keys) changed += 1;
  }
  return {
    created,
    changed: changed + Math.abs(after.descriptions - before.descriptions - created),
  };
}

export async function runLoadTest(options: LoadTestOptions): Promise<{
  measurements: Measurements;
  checks: Check[];
  table: string;
}> {
  const project = assertLoadTestEnvironment(process.env);
  // Always set, never kept from the caller: the Admin SDK takes its project from here.
  process.env.FIREBASE_CONFIG = JSON.stringify({
    projectId: project,
    storageBucket: `${project}.appspot.com`,
  });
  const counters: Counters = newCounters();
  const db = counted(adminDb(), counters);
  const now = new Date();
  const data = buildLoadData({ ...LOAD_DEFAULTS, ...options, now });

  await seedBasics(db, now);
  await seedQueuedJobs(db, data, now);

  const config = AppConfigSchema.parse({
    ownerUid: 'owner-load',
    schemaVersion: 1,
    monthlyCapPence: MONTHLY_CAP_PENCE,
    createdAt: now,
    updatedAt: now,
  });
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  const random = prng(LOAD_DEFAULTS.seed + 1);

  // Peak RSS, sampled.
  let peakRss = 0;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 250);

  async function oneRun() {
    const marks: { name: ProbeMark; at: number }[] = [];
    const calls: { purpose: 'triage' | 'deepRead'; start: number; end: number }[] = [];
    const records: FetchRecord[] = [];
    const probe: FunnelProbe = (name) => marks.push({ name, at: Date.now() });
    const fetchImpl = loadFetch(data.boards, { records });
    const transport = loadTransport({
      inner: fakeTransport(),
      sleep,
      random,
      onSend: (purpose, start, end) => calls.push({ purpose, start, end }),
    });
    const runner = funnelFor({ firestore: db, config, transport, fetch: fetchImpl, probe });
    let outcome: FunnelOutcome | undefined;
    const deps: ScanDeps = {
      store: firestoreScanStore(db),
      readCriteria: async () => {
        const { getCurrentCriteria } = await import('../criteria.js');
        return getCurrentCriteria(db);
      },
      createSources,
      httpFor: (deadline, paused) => scanHttpClient(fetchImpl, deadline, paused),
      secrets: {},
      seed: data.companies,
      disabledSources: SCAN_SOURCE_IDS.filter((id) => id !== 'greenhouse'),
      cooldownMs: 0,
      trigger: 'schedule',
      now: () => new Date(),
      funnel: async (input) => {
        outcome = await runner(input);
        return outcome;
      },
    };
    const t0 = Date.now();
    const result = await runScan(deps);
    const seconds = (Date.now() - t0) / 1000;
    return { result, outcome, marks, calls, records, t0, seconds };
  }

  Object.assign(counters, newCounters());
  const first = await oneRun();
  const reads = counters.observed > 0 ? counters.reads : null;
  const writes = counters.observed > 0 ? counters.writes : null;
  const maxBatchOps = counters.batches.length > 0 ? Math.max(...counters.batches) : null;
  const afterFirst = await snapshotJobs(db);

  await oneRun();
  const afterSecond = await snapshotJobs(db);
  const run2 = diffSnapshots(afterFirst, afterSecond);

  const outcome = first.outcome;
  if (!outcome) throw new Error(`The funnel did not run: ${JSON.stringify(first.result)}`);

  const at = (name: ProbeMark, which: 'first' | 'last' = 'first') => {
    const hits = first.marks.filter((m) => m.name === name);
    const hit = which === 'first' ? hits[0] : hits[hits.length - 1];
    return hit ? (hit.at - first.t0) / 1000 : null;
  };
  const span = (start: ProbeMark, end: ProbeMark) => {
    const s = at(start);
    const e = at(end, 'last');
    return s !== null && e !== null ? e - s : null;
  };
  const starts = (purpose: 'triage' | 'deepRead') =>
    first.calls.filter((c) => c.purpose === purpose).map((c) => (c.start - first.t0) / 1000);
  const hydrateStarts = first.marks.filter((m) => m.name === 'hydrate.start');
  const hydrateEnds = first.marks.filter((m) => m.name === 'hydrate.end');
  const hydrateTotal = hydrateStarts.reduce(
    (sum, start, index) => sum + ((hydrateEnds[index]?.at ?? start.at) - start.at) / 1000,
    0,
  );
  const byStatus: Record<string, number> = {};
  for (const record of first.records) {
    byStatus[String(record.status)] = (byStatus[String(record.status)] ?? 0) + 1;
  }
  const usage = await db.doc(PATHS.usage(monthKey(new Date()))).get();
  const reservations = (usage.data() as { reservations?: Record<string, unknown> } | undefined)
    ?.reservations;

  // The wipe, timed per call, on what the two runs left.
  const wipeCalls: WipeCall[] = [];
  const store = firestoreWipeStore(db, adminBucket());
  const resetStore = firestoreResetStore(db);
  let wipeDocs = 0;
  for (let call = 0; call < 40; call += 1) {
    const started = Date.now();
    const result = await deleteAllDataHandler(
      { confirm: 'DELETE', resetProfile: false },
      {
        store,
        reset: {
          store: resetStore,
          deleteFiles: bucketFileDeleter(adminBucket()),
          now: () => new Date(),
        },
        now: () => new Date(),
      },
    );
    wipeDocs += result.deleted.documents;
    wipeCalls.push({
      documents: result.deleted.documents,
      files: result.deleted.files,
      seconds: (Date.now() - started) / 1000,
      done: result.done,
    });
    if (result.done) break;
  }
  clearInterval(sampler);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const s1Mark = at('s1.start');
  const measurements: Measurements = {
    jobs: options.jobs,
    s1Passes: data.expected.s1Passes,
    expectedS3: Math.min(FUNNEL.s3MaxJobs, data.expected.s2Passes + data.alerts.length),
    runSeconds: first.seconds,
    lastFetchAt:
      first.records.length > 0
        ? Math.max(...first.records.map((r) => (r.at - first.t0) / 1000))
        : null,
    fetches: { total: first.records.length, byStatus },
    lastS2StartAt: starts('triage').length > 0 ? Math.max(...starts('triage')) : null,
    lastS3StartAt: starts('deepRead').length > 0 ? Math.max(...starts('deepRead')) : null,
    s2Calls: outcome.perStage.s2.in,
    s3Calls: outcome.perStage.s3.in,
    s2Stop: outcome.budget.stops?.s2 ?? null,
    s3Stop: outcome.budget.stops?.s3 ?? null,
    s3StartedAt: at('s3.start'),
    s3EndedAt: at('s3.end', 'last'),
    stageTimes: {
      ingest: s1Mark,
      s1: span('s1.start', 's1.end'),
      sweep: span('sweep.start', 'sweep.end'),
      s2: span('s2.start', 's2.end'),
      hydrate: hydrateStarts.length > 0 ? hydrateTotal : null,
      s3: span('s3.start', 's3.end'),
    },
    sweepCounts: {
      s2Expired: outcome.perStage.s2.expired,
      s3Expired: outcome.perStage.s3.expired,
      released: 0,
    },
    hydrate: {
      reads: hydrateStarts.length,
      ok: outcome.perStage.hydrate.ok,
      failed: outcome.perStage.hydrate.failed,
      totalSeconds: hydrateTotal,
    },
    leasePence: outcome.budget.leasePence,
    usedPence: outcome.budget.usedPence,
    reservationsLeft: reservations ? Object.keys(reservations).length : 0,
    reads,
    writes,
    maxBatchOps,
    peakRssMiB: peakRss / 1_048_576,
    run2: { new: run2.created, unexpectedWrites: run2.changed },
    wipe: { documents: wipeDocs, calls: wipeCalls },
  };
  const checks = evaluate(measurements);
  return { measurements, checks, table: formatTable(measurements, checks) };
}
