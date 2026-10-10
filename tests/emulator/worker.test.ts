/**
 * The CV worker against the Firestore and Storage emulators, with the fake model (M7 7D.2).
 * Run with `npm run test:rules`. Proves: start → skip all → generating → ready end to end with
 * the real store, the real renderer and the four Storage objects; a schema-valid `cvs` doc at the
 * path the owner-read rule covers (tests/rules); one `application_stage` event per move; the
 * spend recorded under `cvWrite` with an `application-` reservation; and that two overlapping
 * runs make one model call between them (the attempt precondition).
 */
import {
  AppConfigSchema,
  ApplicationSchema,
  COLLECTIONS,
  CvDocSchema,
  DOCS,
  EventSchema,
  PATHS,
  UsageSchema,
  type JobRequirement,
} from '@hireframe/shared';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applicationHandler } from '../../functions/src/applications/handler.js';
import { applicationLlmDeps } from '../../functions/src/applications/llm.js';
import { firestoreApplicationStore } from '../../functions/src/applications/store.js';
import { runCvWorker } from '../../functions/src/applications/worker.js';
import { cvWorkerDeps } from '../../functions/src/applications/worker-wiring.js';
import { FAKE_CV_FACTS } from '../../functions/src/fixtures/fake-cv-response.js';
import { llmCall } from '../../functions/src/llm/call.js';
import { fakeTransport } from '../../functions/src/llm/fake-transport.js';
import type { LlmTransport } from '../../functions/src/llm/transport.js';
import { firestoreUsageStore } from '../../functions/src/llm/usage-store.js';
import { bucketFileDeleter, firestoreProfileStore } from '../../functions/src/profile/store.js';
import { timestampsToDates } from '../../functions/src/timestamps.js';

const NOW = new Date('2026-10-12T08:00:00Z');
const JOB_ID = 'job-1';

let app: App;
let db: Firestore;
const bucket = () => getStorage(app).bucket();

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    throw new Error('Run with `npm run test:rules`.');
  }
  app = initializeApp(
    { projectId: 'demo-hireframe', storageBucket: 'demo-hireframe.appspot.com' },
    'worker-test',
  );
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

const requirement = (text: string): JobRequirement => ({
  text,
  level: 'must',
  type: 'skill',
  match: 'missing',
  gap: 'tool',
  factIds: [],
});

beforeEach(async () => {
  for (const path of [
    COLLECTIONS.applications,
    COLLECTIONS.events,
    COLLECTIONS.profile,
    COLLECTIONS.usage,
    COLLECTIONS.cvs,
    COLLECTIONS.jobs,
  ]) {
    await db.recursiveDelete(db.collection(path));
  }
  await bucket().deleteFiles({ force: true });
  await db.doc(PATHS.job(JOB_ID)).set({
    title: 'Data Analyst',
    company: 'Northwind Analytics',
    location: 'London, UK',
    city: 'london',
    country: 'GB',
    remote: 'hybrid',
    url: 'https://jobs.example.com/1',
    sources: [
      { id: 'greenhouse', url: 'https://jobs.example.com/1', externalId: '1', seenAt: NOW },
    ],
    keys: ['d:1'],
    dedupeKey: 'd:1',
    firstSeenAt: NOW,
    descriptionRef: `jobs/${JOB_ID}/description/raw`,
    descriptionKind: 'full',
    stage: 's3',
    status: 'new',
    verdict: 'apply',
    fitScore: 8,
    luckScore: 6,
    reason: 'Strong match.',
    judgedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    deep: {
      requirements: [requirement('Advanced SQL for reporting'), requirement('Tableau dashboards')],
      rubric: { evidence: 1, companyFit: 0.5 },
      employer: 'small',
      model: { fit: 8, luck: 6, verdict: 'apply' },
      reason: 'Strong match.',
      talkingPoints: ['Client onboarding'],
    },
  });
  await db.doc(PATHS.jobDescription(JOB_ID)).set({
    text: 'Northwind Analytics is hiring a Data Analyst to support customer onboarding.',
    kind: 'full',
    sourceId: 'greenhouse',
    fetchedAt: NOW,
    schemaVersion: 1,
  });
  await db.doc(DOCS.cvHeader).set({
    name: 'Alex Example',
    email: 'alex@example.com',
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  });
  await firestoreProfileStore(db).addManualFacts(
    FAKE_CV_FACTS.map((draft) => ({ draft, evidenceVerified: true })),
    NOW,
  );
});

function applicationDeps() {
  const llm = applicationLlmDeps({
    transport: fakeTransport(),
    usage: firestoreUsageStore(db),
    dailyCapPence: 60,
    capPence: 1_500,
    fxUsdToGbp: 0.85,
  });
  const profile = firestoreProfileStore(db);
  return {
    store: firestoreApplicationStore(db),
    facts: () => profile.listFacts(),
    llm: <T>(input: Parameters<typeof llmCall<T>>[1]) => llmCall(llm, input),
    deleteFiles: bucketFileDeleter(bucket()),
    now: () => NOW,
  };
}

const config = AppConfigSchema.parse({
  ownerUid: 'owner-1',
  createdAt: NOW,
  updatedAt: NOW,
  schemaVersion: 1,
});

/** The fake transport with a count of the requests that reached "the API". */
function countingTransport(): LlmTransport & { sends: () => number } {
  const inner = fakeTransport();
  let sends = 0;
  return {
    countTokens: (request) => inner.countTokens(request),
    send(request) {
      sends += 1;
      return inner.send(request);
    },
    sends: () => sends,
  };
}

function workerDeps(transport: LlmTransport) {
  return cvWorkerDeps({ firestore: db, bucket: bucket(), transport, config, now: () => NOW });
}

async function startGenerating() {
  const call = (data: unknown) =>
    applicationHandler(data, () => Promise.resolve(applicationDeps()));
  await call({ action: 'start', jobId: JOB_ID });
  await call({ action: 'skipAll', jobId: JOB_ID });
}

async function application() {
  const snapshot = await db.doc(PATHS.application(JOB_ID)).get();
  return ApplicationSchema.parse(timestampsToDates(snapshot.data()));
}

describe('the CV worker on the emulator', () => {
  it('goes from generating to ready with the four files and a valid cvs doc', async () => {
    await startGenerating();
    expect((await application()).stage).toBe('generating');

    const transport = countingTransport();
    const summary = await runCvWorker(workerDeps(transport));
    expect(summary).toMatchObject({ read: 1, ready: 1, stoppedBy: null });
    expect(transport.sends()).toBe(1);

    const stored = await application();
    expect(stored).toMatchObject({
      stage: 'ready',
      attempt: 1,
      cvIds: [`${JOB_ID}-v1`],
      currentCvId: `${JOB_ID}-v1`,
    });

    const cvId = `${JOB_ID}-v1`;
    const doc = CvDocSchema.parse(timestampsToDates((await db.doc(PATHS.cv(cvId)).get()).data()));
    expect(doc.storagePaths).toEqual({
      cvPdf: `cvs/${cvId}/cv.pdf`,
      cvDocx: `cvs/${cvId}/cv.docx`,
      notePdf: `cvs/${cvId}/cover-note.pdf`,
      noteDocx: `cvs/${cvId}/cover-note.docx`,
    });
    for (const [key, path] of Object.entries(doc.storagePaths)) {
      const [bytes] = await bucket().file(path).download();
      expect(bytes.length, key).toBeGreaterThan(500);
      // A PDF starts "%PDF", a DOCX is a zip ("PK").
      expect(bytes.subarray(0, key.endsWith('Pdf') ? 4 : 2).toString('latin1')).toBe(
        key.endsWith('Pdf') ? '%PDF' : 'PK',
      );
    }
    expect(doc.factIds.length).toBeGreaterThan(0);

    const events = (await db.collection(COLLECTIONS.events).get()).docs.map((d) =>
      EventSchema.parse(timestampsToDates(d.data())),
    );
    const moves = events
      .flatMap((event) =>
        event.type === 'application_stage' ? [`${event.from ?? 'null'}>${event.to}`] : [],
      )
      .sort();
    expect(moves).toEqual(['generating>ready', 'needs_input>generating', 'null>needs_input']);

    const month = (await db.collection(COLLECTIONS.usage).get()).docs[0];
    const usage = UsageSchema.parse(timestampsToDates(month?.data()));
    expect(usage.byPurpose.cvWrite).toBeGreaterThan(0);
    expect(usage.reservations).toEqual({});
  });

  it('makes one model call when two runs overlap: the attempt count is a precondition', async () => {
    await startGenerating();
    const a = countingTransport();
    const b = countingTransport();
    const results = await Promise.allSettled([
      runCvWorker(workerDeps(a)),
      runCvWorker(workerDeps(b)),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(a.sends() + b.sends()).toBe(1);
    expect((await application()).stage).toBe('ready');
    expect((await application()).attempt).toBe(1);
  });

  it('blocks a job with no header without a call or a count', async () => {
    await startGenerating();
    await db.doc(DOCS.cvHeader).delete();
    const transport = countingTransport();
    const summary = await runCvWorker(workerDeps(transport));
    expect(summary.blocked).toBe(1);
    expect(transport.sends()).toBe(0);
    expect(await application()).toMatchObject({
      stage: 'chosen',
      attempt: 0,
      blocked: { code: 'cv_header_missing' },
    });
  });

  it('treats an invalid header document as a missing one', async () => {
    await startGenerating();
    await db.doc(DOCS.cvHeader).update({ email: 'not-an-email' });
    const transport = countingTransport();
    await runCvWorker(workerDeps(transport));
    expect(transport.sends()).toBe(0);
    expect((await application()).blocked?.code).toBe('cv_header_missing');
  });

  it('writes nothing for a job the owner withdrew before the run', async () => {
    await startGenerating();
    const call = (data: unknown) =>
      applicationHandler(data, () => Promise.resolve(applicationDeps()));
    await call({ action: 'withdraw', jobId: JOB_ID, deleteFiles: false });
    const transport = countingTransport();
    const summary = await runCvWorker(workerDeps(transport));
    expect(summary.read).toBe(0);
    expect(transport.sends()).toBe(0);
    expect((await bucket().getFiles({ prefix: 'cvs/' }))[0]).toHaveLength(0);
  });
});
