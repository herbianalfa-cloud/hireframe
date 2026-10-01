/**
 * Storage rules tests (PRD R1, ADR-011). Run with `npm run test:rules` (needs the emulators).
 * The owner UID comes from Firestore `config/app` via cross-service rules. M2 allows exactly one
 * client write: the owner uploading a new CV (PDF/DOCX, at most 5 MiB) to
 * `profile/documents/{docId}/cv.{pdf|docx}`. Uploads can't be overwritten or deleted.
 */
import { readFileSync } from 'node:fs';

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { CV_MIME_TYPES, DOCS, MAX_CV_BYTES, STORAGE_PATHS } from '@hireframe/shared';
import { doc, setDoc } from 'firebase/firestore';
import {
  deleteObject,
  getBytes,
  getMetadata,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'firebase/storage';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const OWNER = 'owner-uid';
const STRANGER = 'stranger-uid';

const OWNER_READABLE = ['profile/documents/abcdefghij0123456789/cv.docx', 'cvs/cv-1/cv.pdf'];
const NEW_DOC_ID = 'ABCDEFGHIJ0123456789';
const ADMIN_ONLY = ['backups/2026-09-27/export.json', 'unknown/file.txt'];

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-hireframe',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
    storage: { rules: readFileSync('storage.rules', 'utf8') },
  });
});

afterAll(async () => {
  await env.cleanup();
});

async function seed(options: { withOwner: boolean }): Promise<void> {
  await env.clearFirestore();
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const storage = ctx.storage();
    for (const path of [...OWNER_READABLE, ...ADMIN_ONLY]) {
      await uploadBytes(ref(storage, path), new Uint8Array([1, 2, 3]));
    }
    if (options.withOwner) {
      await setDoc(doc(ctx.firestore(), DOCS.appConfig), { ownerUid: OWNER, schemaVersion: 1 });
    }
  });
}

function storageFor(who: 'anon' | 'stranger' | 'owner'): FirebaseStorage {
  if (who === 'anon') return env.unauthenticatedContext().storage();
  return env.authenticatedContext(who === 'owner' ? OWNER : STRANGER).storage();
}

async function expectReadsDenied(storage: FirebaseStorage, path: string): Promise<void> {
  await assertFails(getMetadata(ref(storage, path)));
  await assertFails(getBytes(ref(storage, path)));
}

async function expectWritesDenied(storage: FirebaseStorage, path: string): Promise<void> {
  await assertFails(uploadBytes(ref(storage, path), new Uint8Array([9])));
  await assertFails(uploadBytes(ref(storage, `${path}.new`), new Uint8Array([9])));
  await assertFails(deleteObject(ref(storage, path)));
}

describe('with an owner configured', () => {
  beforeEach(async () => {
    await seed({ withOwner: true });
  });

  describe.each(OWNER_READABLE)('%s', (path) => {
    it.each(['anon', 'stranger'] as const)('denies %s every read and write', async (who) => {
      await expectReadsDenied(storageFor(who), path);
      await expectWritesDenied(storageFor(who), path);
    });

    it('lets the owner read', async () => {
      await assertSucceeds(getMetadata(ref(storageFor('owner'), path)));
      await assertSucceeds(getBytes(ref(storageFor('owner'), path)));
    });

    it('denies the owner overwriting or deleting an existing object', async () => {
      await expectWritesDenied(storageFor('owner'), path);
    });
  });

  it.each(ADMIN_ONLY)('denies everyone, owner included, on %s', async (path) => {
    for (const who of ['anon', 'stranger', 'owner'] as const) {
      await expectReadsDenied(storageFor(who), path);
      await expectWritesDenied(storageFor(who), path);
    }
  });
});

describe('bootstrap: before config/app exists (fails closed)', () => {
  beforeEach(async () => {
    await seed({ withOwner: false });
  });

  it.each(OWNER_READABLE)('denies every signed-in user reading %s', async (path) => {
    await expectReadsDenied(storageFor('owner'), path);
    await expectReadsDenied(storageFor('stranger'), path);
  });
});

describe('CV upload', () => {
  beforeEach(async () => {
    await seed({ withOwner: true });
  });

  const pdf = STORAGE_PATHS.profileDocument(NEW_DOC_ID, 'pdf');
  const docx = STORAGE_PATHS.profileDocument(NEW_DOC_ID, 'docx');
  const bytes = (size: number) => new Uint8Array(size);
  const upload = (
    who: 'anon' | 'stranger' | 'owner',
    path: string,
    size: number,
    contentType: string,
  ) => uploadBytes(ref(storageFor(who), path), bytes(size), { contentType });

  it('lets the owner upload a new PDF or DOCX CV', async () => {
    await assertSucceeds(upload('owner', pdf, 1024, CV_MIME_TYPES.pdf));
    await assertSucceeds(upload('owner', docx, MAX_CV_BYTES, CV_MIME_TYPES.docx));
  });

  it.each([
    ['an oversized file', pdf, MAX_CV_BYTES + 1, CV_MIME_TYPES.pdf],
    ['an empty file', pdf, 0, CV_MIME_TYPES.pdf],
    ['a wrong content type', pdf, 1024, 'text/html'],
    ['a PDF content type on cv.docx', docx, 1024, CV_MIME_TYPES.pdf],
    ['a DOCX content type on cv.pdf', pdf, 1024, CV_MIME_TYPES.docx],
    ['another file name', `profile/documents/${NEW_DOC_ID}/notes.pdf`, 1024, CV_MIME_TYPES.pdf],
    ['a bad document ID', 'profile/documents/short/cv.pdf', 1024, CV_MIME_TYPES.pdf],
    ['a nested path', `profile/documents/${NEW_DOC_ID}/x/cv.pdf`, 1024, CV_MIME_TYPES.pdf],
  ])('denies the owner %s', async (_name, path, size, contentType) => {
    await assertFails(upload('owner', path, size, contentType));
  });

  it('denies overwriting or deleting an uploaded CV', async () => {
    // A path no other test uploads to: the emulator can keep object metadata after clearStorage.
    const own = STORAGE_PATHS.profileDocument('OVERWRITE0123456789x', 'pdf');
    await assertSucceeds(upload('owner', own, 1024, CV_MIME_TYPES.pdf));
    await assertFails(upload('owner', own, 2048, CV_MIME_TYPES.pdf));
    await assertFails(deleteObject(ref(storageFor('owner'), own)));
  });

  it.each(['anon', 'stranger'] as const)('denies %s uploading a CV', async (who) => {
    await assertFails(upload(who, pdf, 1024, CV_MIME_TYPES.pdf));
  });

  it('denies uploads before config/app exists (fails closed)', async () => {
    await seed({ withOwner: false });
    await assertFails(upload('owner', pdf, 1024, CV_MIME_TYPES.pdf));
  });

  it('still denies every client write to cvs/** and backups/**', async () => {
    await assertFails(upload('owner', 'cvs/cv-2/cv.pdf', 1024, CV_MIME_TYPES.pdf));
    await assertFails(upload('owner', 'backups/2026-10-01/export.json', 10, 'application/json'));
  });
});
