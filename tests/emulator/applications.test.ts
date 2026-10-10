/**
 * The `application` callable's real store against the Firestore emulator, with the fake model
 * (M7 7D.1). Run with `npm run test:rules`. Proves: start → answer → skip → generating end to end
 * with schema-valid documents and one `application_stage` event per stage change; concurrent
 * starts and concurrent answers each leave exactly one winner and no stray fact or event; an
 * answer's facts carry `answerFor` and a v1 snapshot; withdraw deletes the files and `cvs`
 * docs it was asked to.
 */
import {
  ApplicationSchema,
  COLLECTIONS,
  DOCS,
  EventSchema,
  FactSchema,
  PATHS,
  type JobRequirement,
} from '@hireframe/shared';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applicationHandler } from '../../functions/src/applications/handler.js';
import { applicationLlmDeps } from '../../functions/src/applications/llm.js';
import type { ApplicationDeps } from '../../functions/src/applications/run.js';
import { firestoreApplicationStore } from '../../functions/src/applications/store.js';
import { llmCall } from '../../functions/src/llm/call.js';
import { fakeTransport } from '../../functions/src/llm/fake-transport.js';
import { firestoreUsageStore } from '../../functions/src/llm/usage-store.js';
import { bucketFileDeleter, firestoreProfileStore } from '../../functions/src/profile/store.js';
import { timestampsToDates } from '../../functions/src/timestamps.js';

const NOW = new Date('2026-10-08T12:00:00Z');
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
    'applications-test',
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
    remote: 'unknown',
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
      talkingPoints: [],
    },
  });
  await db.doc(DOCS.cvHeader).set({
    name: 'Alex Example',
    email: 'alex@example.com',
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  });
});

function deps(): ApplicationDeps {
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
    llm: (input) => llmCall(llm, input),
    deleteFiles: bucketFileDeleter(bucket()),
    now: () => NOW,
  };
}

const call = (data: unknown) => applicationHandler(data, () => Promise.resolve(deps()));

async function application() {
  const snapshot = await db.doc(PATHS.application(JOB_ID)).get();
  return ApplicationSchema.parse(timestampsToDates(snapshot.data()));
}

async function events() {
  const snapshot = await db.collection(COLLECTIONS.events).get();
  return snapshot.docs.map((doc) => EventSchema.parse(timestampsToDates(doc.data())));
}

describe('application on the emulator', () => {
  it('goes start → answer → skip → generating, with one event per stage change', async () => {
    const started = await call({ action: 'start', jobId: JOB_ID });
    expect(started).toMatchObject({ stage: 'needs_input', unanswered: 2 });
    const [first, second] = (await application()).questions;

    const answered = await call({
      action: 'answer',
      jobId: JOB_ID,
      questionId: first?.id,
      text: 'I wrote weekly SQL reports for the sales team.',
    });
    expect(answered).toMatchObject({ stage: 'needs_input', unanswered: 1 });
    expect(answered.factIds).toHaveLength(1);
    const skipped = await call({ action: 'skip', jobId: JOB_ID, questionId: second?.id });
    expect(skipped).toMatchObject({ stage: 'generating', unanswered: 0 });

    const stored = await application();
    expect(stored.attempt).toBe(0);
    expect(stored.job).toEqual({
      title: 'Data Analyst',
      company: 'Northwind Analytics',
      verdict: 'apply',
    });
    expect(
      (await events()).map((event) => (event.type === 'application_stage' ? event.to : null)),
    ).toEqual(expect.arrayContaining(['needs_input', 'generating']));
    expect(await events()).toHaveLength(2);
  });

  it('writes the answer as a manual fact for the job, with its v1 snapshot', async () => {
    await call({ action: 'start', jobId: JOB_ID });
    const [first] = (await application()).questions;
    const { factIds } = await call({
      action: 'answer',
      jobId: JOB_ID,
      questionId: first?.id,
      text: 'I wrote weekly SQL reports for the sales team.',
    });
    const factId = factIds?.[0] ?? '';
    const fact = FactSchema.parse(
      timestampsToDates((await db.doc(PATHS.fact(factId)).get()).data()),
    );
    expect(fact).toMatchObject({
      source: 'manual',
      status: 'active',
      version: 1,
      answerFor: { jobId: JOB_ID },
    });
    const version = (await db.doc(PATHS.factVersion(factId, 1)).get()).data();
    expect(version).toMatchObject({ change: 'created' });
    expect((await application()).questions[0]?.answer).toEqual({ kind: 'fact', factIds: [factId] });
  });

  it('lets exactly one of two concurrent starts through', async () => {
    const results = await Promise.allSettled([
      call({ action: 'start', jobId: JOB_ID }),
      call({ action: 'start', jobId: JOB_ID }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it('lets exactly one of two concurrent answers write its fact', async () => {
    await call({ action: 'start', jobId: JOB_ID });
    const [first] = (await application()).questions;
    const results = await Promise.allSettled([
      call({ action: 'answer', jobId: JOB_ID, questionId: first?.id, text: 'First answer here.' }),
      call({
        action: 'answer',
        jobId: JOB_ID,
        questionId: first?.id,
        text: 'Second, different answer.',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await db.collection(PATHS.facts).get()).size).toBe(1);
    expect((await db.collectionGroup('versions').get()).size).toBe(1);
  });

  it('stays in chosen without a header, and Retry moves on once there is one', async () => {
    await db.doc(DOCS.cvHeader).delete();
    expect(await call({ action: 'start', jobId: JOB_ID })).toMatchObject({
      stage: 'chosen',
      blocked: 'cv_header_missing',
    });
    await db.doc(DOCS.cvHeader).set({
      name: 'Alex Example',
      email: 'alex@example.com',
      createdAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
    });
    expect(await call({ action: 'retry', jobId: JOB_ID })).toMatchObject({ stage: 'needs_input' });
  });

  it('withdraws and deletes the CV files and docs when asked', async () => {
    await call({ action: 'start', jobId: JOB_ID });
    const cvId = `${JOB_ID}-v1`;
    await db.doc(PATHS.cv(cvId)).set({ jobId: JOB_ID });
    for (const file of ['cv.pdf', 'cv.docx', 'cover-note.pdf', 'cover-note.docx']) {
      await bucket().file(`cvs/${cvId}/${file}`).save('fake');
    }
    await bucket().file(`cvs/${JOB_ID}-v10/cv.pdf`).save('another version, kept');
    await db.doc(PATHS.application(JOB_ID)).update({ cvIds: [cvId], currentCvId: cvId });

    expect(await call({ action: 'withdraw', jobId: JOB_ID, deleteFiles: true })).toMatchObject({
      stage: 'withdrawn',
    });
    expect((await db.doc(PATHS.cv(cvId)).get()).exists).toBe(false);
    const [left] = await bucket().getFiles({ prefix: 'cvs/' });
    expect(left.map((file) => file.name)).toEqual([`cvs/${JOB_ID}-v10/cv.pdf`]);
    expect((await application()).cvIds).toEqual([]);

    // A withdrawn job can start again.
    expect(await call({ action: 'start', jobId: JOB_ID })).toMatchObject({ stage: 'needs_input' });
  });
});
