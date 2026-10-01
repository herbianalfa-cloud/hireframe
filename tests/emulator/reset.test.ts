/**
 * resetProfile against the Firestore and Storage emulators (ADR-023). Run with
 * `npm run test:rules`, which starts both. Proves the reset removes every fact, version, upload
 * document and uploaded file, and leaves config, criteria and usage alone.
 */
import { DOCS, PATHS, STORAGE_PATHS } from '@hireframe/shared';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError } from 'firebase-functions/https';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resetProfileHandler, type ResetDeps } from '../../functions/src/profile/reset.js';
import { bucketFileDeleter, firestoreResetStore } from '../../functions/src/profile/store.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const DOC_IDS = ['abcdefghij0123456789', 'zyxwvutsrq9876543210'];
const CONFIRM = { confirm: 'RESET' };

let app: App;
let db: Firestore;
let deps: ResetDeps;

const bucket = () => getStorage(app).bucket();

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    throw new Error('Run with `npm run test:rules`.');
  }
  app = initializeApp(
    { projectId: 'demo-hireframe', storageBucket: 'demo-hireframe.appspot.com' },
    'reset-test',
  );
  db = getFirestore(app);
  deps = {
    store: firestoreResetStore(db),
    deleteFiles: bucketFileDeleter(bucket()),
    now: () => NOW,
  };
});

afterAll(async () => {
  await deleteApp(app);
});

function upload(status: string, updatedAt = NOW) {
  return { kind: 'pdf', storagePath: 'x', status, createdAt: NOW, updatedAt, schemaVersion: 1 };
}

beforeEach(async () => {
  for (const path of ['profile', 'config', 'criteria', 'usage']) {
    await db.recursiveDelete(db.collection(path));
  }
  await bucket().deleteFiles({ force: true });

  await db.doc(DOCS.appConfig).set({ ownerUid: 'owner-uid', schemaVersion: 1 });
  await db.doc(DOCS.criteriaCurrent).set({ version: 1 });
  await db.doc(PATHS.usage('2026-10')).set({ spendPence: 12 });
  for (const factId of ['f1', 'f2', 'f3']) {
    await db.doc(PATHS.fact(factId)).set({ text: 'Fake fact' });
    await db.doc(PATHS.factVersion(factId, 1)).set({ change: 'created' });
    await db.doc(PATHS.factVersion(factId, 2)).set({ change: 'edit' });
  }
  for (const docId of DOC_IDS) {
    await db.doc(PATHS.document(docId)).set(upload('parsed'));
    await bucket().file(STORAGE_PATHS.profileDocument(docId, 'pdf')).save('%PDF-1.4 fake');
  }
  await bucket().file('backups/2026-10-01.json').save('{}');
});

describe('resetProfile on the emulators', () => {
  it('deletes facts, versions, documents and uploaded files, and nothing else', async () => {
    await expect(resetProfileHandler(CONFIRM, deps)).resolves.toEqual({
      facts: 3,
      documents: 2,
      files: 2,
    });

    expect((await db.collection(PATHS.facts).get()).size).toBe(0);
    expect((await db.collection(PATHS.factVersions('f1')).get()).size).toBe(0);
    expect((await db.collection(PATHS.documents).get()).size).toBe(0);
    const [left] = await bucket().getFiles();
    expect(left.map((file) => file.name)).toEqual(['backups/2026-10-01.json']);

    expect((await db.doc(DOCS.appConfig).get()).exists).toBe(true);
    expect((await db.doc(DOCS.criteriaCurrent).get()).exists).toBe(true);
    expect((await db.doc(PATHS.usage('2026-10')).get()).data()).toEqual({ spendPence: 12 });
  });

  it('is safe to run again: the second run finds nothing', async () => {
    await resetProfileHandler(CONFIRM, deps);
    await expect(resetProfileHandler(CONFIRM, deps)).resolves.toEqual({
      facts: 0,
      documents: 0,
      files: 0,
    });
  });

  it('refuses while a CV is being read, and deletes nothing', async () => {
    await db.doc(PATHS.document(DOC_IDS[0] ?? '')).set(upload('parsing', NOW));
    const error: unknown = await resetProfileHandler(CONFIRM, deps).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HttpsError);
    expect((error as HttpsError).code).toBe('failed-precondition');
    expect((await db.collection(PATHS.facts).get()).size).toBe(3);
    expect(
      (await bucket().getFiles({ prefix: STORAGE_PATHS.profileDocumentsPrefix }))[0],
    ).toHaveLength(2);
  });

  it('goes ahead past a parse abandoned long ago', async () => {
    const longAgo = new Date(NOW.getTime() - 60 * 60_000);
    await db.doc(PATHS.document(DOC_IDS[0] ?? '')).set(upload('parsing', longAgo));
    await expect(resetProfileHandler(CONFIRM, deps)).resolves.toMatchObject({ facts: 3 });
  });
});
