/**
 * deleteAllData against the Firestore and Storage emulators (ADR-057). Run with
 * `npm run test:rules`. Proves a wipe loop empties every listed collection, every job
 * description and the generated CV files in several calls, ends on a check pass that deletes
 * nothing, and leaves config, criteria, usage, locks/retention, nonces, each source's quota and
 * pauses, and Storage `backups/` alone. The profile goes only when ticked.
 */
import {
  COLLECTIONS,
  DOCS,
  PATHS,
  STORAGE_PATHS,
  type DeleteAllDataResult,
} from '@hireframe/shared';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bucketFileDeleter, firestoreResetStore } from '../../functions/src/profile/store.js';
import { firestoreScanStore } from '../../functions/src/scan/store.js';
import { deleteAllDataHandler, type WipeDeps } from '../../functions/src/wipe/run.js';
import { firestoreWipeStore } from '../../functions/src/wipe/store.js';

const NOW = new Date('2026-10-14T12:00:00Z');
const SMALL = { maxDocuments: 40, pageSize: 10, maxStoragePages: 2, storagePageSize: 3 };

let app: App;
let db: Firestore;
let deps: WipeDeps;

const bucket = () => getStorage(app).bucket();

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    throw new Error('Run with `npm run test:rules`.');
  }
  app = initializeApp(
    { projectId: 'demo-hireframe', storageBucket: 'demo-hireframe.appspot.com' },
    'wipe-test',
  );
  db = getFirestore(app);
  deps = {
    store: firestoreWipeStore(db, bucket()),
    reset: {
      store: firestoreResetStore(db),
      deleteFiles: bucketFileDeleter(bucket()),
      now: () => NOW,
    },
    now: () => NOW,
    limits: SMALL,
  };
});

afterAll(async () => {
  await deleteApp(app);
});

const WIPED = [
  COLLECTIONS.applications,
  COLLECTIONS.cvs,
  COLLECTIONS.jobs,
  COLLECTIONS.runs,
  COLLECTIONS.events,
  COLLECTIONS.alertMessages,
  COLLECTIONS.companies,
] as const;
const KEPT = [
  COLLECTIONS.config,
  COLLECTIONS.criteria,
  COLLECTIONS.usage,
  COLLECTIONS.locks,
  COLLECTIONS.nonces,
  COLLECTIONS.profile,
  COLLECTIONS.sources,
] as const;

const PAUSE = { host: 'apply.workable.com', until: new Date('2026-11-01T00:00:00Z') };
const QUOTA = {
  day: '2026-10-14',
  dayCount: 7,
  week: '2026-W42',
  weekCount: 20,
  month: '2026-10',
  monthCount: 90,
};

async function seed() {
  for (const path of [...WIPED, ...KEPT]) await db.recursiveDelete(db.collection(path));
  await bucket().deleteFiles({ force: true });

  await db.doc(DOCS.appConfig).set({ ownerUid: 'owner-uid', schemaVersion: 1 });
  await db.doc(DOCS.criteriaCurrent).set({ version: 1 });
  await db.doc(PATHS.usage('2026-10')).set({ spendPence: 12 });
  await db.doc('locks/retention').set({ lastRunAt: NOW, schemaVersion: 1 });
  await db.doc('nonces/n1').set({ expireAt: NOW });
  await db.doc(DOCS.profileMain).set({ workRights: 'unrestricted', schemaVersion: 1 });
  await db.doc(DOCS.cvHeader).set({ name: 'Alex Example', schemaVersion: 1 });
  await db.doc(PATHS.fact('f1')).set({ text: 'Fake fact' });
  await db.doc(PATHS.factVersion('f1', 1)).set({ change: 'created' });
  await db.doc(PATHS.document('d1')).set({ status: 'parsed', schemaVersion: 1 });
  await bucket().file(STORAGE_PATHS.profileDocument('d1', 'pdf')).save('%PDF-1.4 fake');

  for (let i = 0; i < 45; i += 1) {
    await db.doc(PATHS.job(`job-${String(i)}`)).set({ title: 'Fake job' });
    await db.doc(PATHS.jobDescription(`job-${String(i)}`)).set({ text: 'Fake text' });
  }
  for (let i = 0; i < 15; i += 1) {
    await db.doc(`runs/run-${String(i)}`).set({ status: 'succeeded' });
    await db.doc(`events/ev-${String(i)}`).set({ type: 'status_change' });
    await db.doc(`companies/co-${String(i)}`).set({ name: 'Fake Co' });
  }
  for (let i = 0; i < 12; i += 1) {
    await db.doc(PATHS.alertMessage(`hash-${String(i)}`)).set({ expireAt: NOW });
    await db.doc(PATHS.application(`job-${String(i)}`)).set({ stage: 'ready' });
    await db.doc(PATHS.cv(`cv-${String(i)}`)).set({ jobId: `job-${String(i)}` });
    await bucket()
      .file(STORAGE_PATHS.cvFile(`cv-${String(i)}`, 'cv', 'pdf'))
      .save('%PDF fake');
  }
  await db.doc(PATHS.source('adzuna')).set({
    status: 'ok',
    lastRunAt: NOW,
    consecutiveFailures: 0,
    lastCounts: { status: 'ok' },
    quota: QUOTA,
    updatedAt: NOW,
    schemaVersion: 1,
  });
  await db.doc(PATHS.source('workable')).set({
    status: 'failing',
    lastRunAt: NOW,
    consecutiveFailures: 2,
    lastCounts: { status: 'failing' },
    pausedHosts: [PAUSE],
    updatedAt: NOW,
    schemaVersion: 1,
  });
  await db.doc(PATHS.source('email')).set({ status: 'ok', bySender: {}, schemaVersion: 1 });
  await bucket().file('backups/x').save('{}');
}

async function loop(data: unknown): Promise<DeleteAllDataResult[]> {
  const results: DeleteAllDataResult[] = [];
  for (let i = 0; i < 60; i += 1) {
    const result = await deleteAllDataHandler(data, deps);
    results.push(result);
    if (result.done) break;
  }
  return results;
}

const count = async (path: string) => (await db.collection(path).count().get()).data().count;

beforeEach(seed);

describe('deleteAllData on the emulators', () => {
  it('empties every listed collection, every description and the CV files, over several calls', async () => {
    const results = await loop({ confirm: 'DELETE', resetProfile: false });
    expect(results.length).toBeGreaterThan(3);
    expect(results.slice(0, -1).every((r) => !r.done)).toBe(true);
    // The loop ends on a call that deleted nothing and found every step empty.
    expect(results.at(-1)).toEqual({
      done: true,
      deleted: { documents: 0, files: 0 },
      remaining: [],
    });
    for (const path of WIPED) expect(await count(path), path).toBe(0);
    const descriptions = await db.collectionGroup('description').count().get();
    expect(descriptions.data().count).toBe(0);
    const [files] = await bucket().getFiles({ prefix: 'cvs/' });
    expect(files).toHaveLength(0);
    // A further call is also done, with nothing deleted.
    await expect(
      deleteAllDataHandler({ confirm: 'DELETE', resetProfile: false }, deps),
    ).resolves.toMatchObject({
      done: true,
      deleted: { documents: 0, files: 0 },
    });
  });

  it('keeps config, criteria, usage, locks/retention, nonces, the profile and backups/', async () => {
    await loop({ confirm: 'DELETE', resetProfile: false });
    for (const path of [
      DOCS.appConfig,
      DOCS.criteriaCurrent,
      PATHS.usage('2026-10'),
      'locks/retention',
      'nonces/n1',
      DOCS.profileMain,
      DOCS.cvHeader,
      PATHS.fact('f1'),
      PATHS.factVersion('f1', 1),
      PATHS.document('d1'),
    ]) {
      expect((await db.doc(path).get()).exists, path).toBe(true);
    }
    const [uploads] = await bucket().getFiles({ prefix: STORAGE_PATHS.profileDocumentsPrefix });
    expect(uploads).toHaveLength(1);
    const [backup] = await bucket().file('backups/x').exists();
    expect(backup).toBe(true);
    // The lock is released and no scan cooldown started.
    const lock = await db.doc(DOCS.scanLock).get();
    expect(lock.get('runId')).toBeUndefined();
    expect(lock.get('lastFinishedAt')).toBeUndefined();
  });

  it('keeps each source’s quota and pauses and deletes the rest of the source docs', async () => {
    await loop({ confirm: 'DELETE', resetProfile: false });
    const sources = await db.collection(COLLECTIONS.sources).get();
    expect(sources.docs.map((d) => d.id).sort()).toEqual(['adzuna', 'workable']);
    const adzuna = (await db.doc(PATHS.source('adzuna')).get()).data();
    expect(Object.keys(adzuna ?? {}).sort()).toEqual(['quota', 'schemaVersion', 'updatedAt']);
    // A scan after the wipe still honours the quota and the paused host.
    const scanStore = firestoreScanStore(db);
    await expect(scanStore.quotas()).resolves.toEqual({ adzuna: QUOTA });
    const pauses = await scanStore.pausedHosts();
    expect(pauses.workable).toEqual([{ host: PAUSE.host, until: PAUSE.until.getTime() }]);
    await expect(scanStore.sourceStates()).resolves.toEqual({});
    // A scan after the wipe writes health again and keeps the same quota and pause.
    expect(pauses.adzuna).toBeUndefined();
  });

  it('also removes the profile when ticked, once everything else is empty, and keeps criteria', async () => {
    const results = await loop({ confirm: 'DELETE', resetProfile: true });
    const first = results.findIndex((r) => r.profile);
    expect(first).toBeGreaterThan(0);
    expect(results[first]?.profile).toEqual({ facts: 1, documents: 1, files: 1 });
    expect(results.at(-1)?.done).toBe(true);
    for (const path of [
      DOCS.profileMain,
      DOCS.cvHeader,
      PATHS.fact('f1'),
      PATHS.factVersion('f1', 1),
      PATHS.document('d1'),
    ]) {
      expect((await db.doc(path).get()).exists, path).toBe(false);
    }
    const [uploads] = await bucket().getFiles({ prefix: STORAGE_PATHS.profileDocumentsPrefix });
    expect(uploads).toHaveLength(0);
    for (const path of [
      DOCS.criteriaCurrent,
      DOCS.appConfig,
      PATHS.usage('2026-10'),
      'locks/retention',
      'nonces/n1',
    ]) {
      expect((await db.doc(path).get()).exists, path).toBe(true);
    }
  });

  it('refuses while a live scan holds the lock and while a CV is being written', async () => {
    await db.doc(DOCS.scanLock).set({
      runId: 'run-x',
      startedAt: NOW,
      holder: 'scan',
      staleAt: new Date(NOW.getTime() + 60_000),
      schemaVersion: 1,
    });
    await expect(
      deleteAllDataHandler({ confirm: 'DELETE', resetProfile: false }, deps),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    await db.doc(DOCS.scanLock).delete();
    await db.doc(PATHS.application('job-0')).set({ stage: 'generating' });
    await expect(
      deleteAllDataHandler({ confirm: 'DELETE', resetProfile: false }, deps),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'Wait for the CV being written.',
    });
    expect(await count(COLLECTIONS.jobs)).toBe(45);
  });

  it('takes over a stale scan lock and holds it as wipe until done', async () => {
    await db.doc(DOCS.scanLock).set({
      runId: 'run-dead',
      startedAt: new Date(NOW.getTime() - 30 * 60_000),
      holder: 'scan',
      schemaVersion: 1,
    });
    await db.doc(PATHS.run('run-dead')).set({ status: 'running', schemaVersion: 1 });
    const first = await deleteAllDataHandler({ confirm: 'DELETE', resetProfile: false }, deps);
    expect(first.deleted.documents).toBeGreaterThan(0);
    const lock = await db.doc(DOCS.scanLock).get();
    expect(lock.get('holder')).toBe('wipe');
    expect(lock.get('runId')).toBe('wipe');
  });
});
