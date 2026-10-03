/**
 * Firestore rules tests (PRD R1, ADR-011). Run with `npm run test:rules` (needs the emulators).
 * Every collection in the data model: anon deny, other user deny, owner read. Writes that don't
 * match an allowed shape are denied to the owner too; the allowed M2 writes (fact edits, criteria
 * versions) are tested in profile.rules.test.ts and criteria.rules.test.ts, and
 * scripts/rules-writes.test.ts fails if any other path gains a client write rule.
 */
import { readFileSync } from 'node:fs';

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { DOCS } from '@hireframe/shared';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const OWNER = 'owner-uid';
const STRANGER = 'stranger-uid';

/** One document per collection/subcollection in docs/ARCHITECTURE.md "Data model". */
const DATA_MODEL_DOCS = [
  DOCS.appConfig,
  'config/other',
  DOCS.criteriaCurrent,
  'criteria/v1',
  DOCS.profileMain,
  'profile/main/facts/fact-1',
  'profile/main/facts/fact-1/versions/1',
  'profile/main/documents/doc-1',
  'companies/company-1',
  'jobs/job-1',
  'jobs/job-1/description/raw',
  'cvs/cv-1',
  'runs/run-1',
  'usage/2026-09',
  'events/event-1',
  DOCS.scanLock,
  'sources/greenhouse',
];

/** Paths outside the data model must be denied even to the owner. */
const UNKNOWN_DOCS = [
  'unknown/doc-1',
  'profile/main/other/doc-1',
  'profile/main/facts/fact-1/other/doc-1',
  'jobs/job-1/other/doc-1',
];

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-hireframe',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});

afterAll(async () => {
  await env.cleanup();
});

function parentCollection(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

async function seed(options: { appConfig: Record<string, unknown> | null }): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const path of [...DATA_MODEL_DOCS, ...UNKNOWN_DOCS]) {
      if (path !== DOCS.appConfig) await setDoc(doc(db, path), { seeded: true });
    }
    if (options.appConfig) await setDoc(doc(db, DOCS.appConfig), options.appConfig);
  });
}

const ownerConfig = { ownerUid: OWNER, schemaVersion: 1 };

// rules-unit-testing hands out its own Firestore type; the modular API accepts it.
type TestFirestore = ReturnType<RulesTestContext['firestore']>;

function dbFor(who: 'anon' | 'stranger' | 'owner'): TestFirestore {
  if (who === 'anon') return env.unauthenticatedContext().firestore();
  return env.authenticatedContext(who === 'owner' ? OWNER : STRANGER).firestore();
}

async function expectAllWritesDenied(db: TestFirestore, path: string): Promise<void> {
  await assertFails(setDoc(doc(db, `${parentCollection(path)}/new-doc`), { x: 1 }));
  await assertFails(setDoc(doc(db, path), { x: 1 }));
  await assertFails(updateDoc(doc(db, path), { x: 2 }));
  await assertFails(deleteDoc(doc(db, path)));
}

describe('with an owner configured', () => {
  beforeEach(async () => {
    await env.clearFirestore();
    await seed({ appConfig: ownerConfig });
  });

  describe.each(DATA_MODEL_DOCS)('%s', (path) => {
    it.each(['anon', 'stranger'] as const)('denies %s every read and write', async (who) => {
      const db = dbFor(who);
      await assertFails(getDoc(doc(db, path)));
      await assertFails(getDocs(collection(db, parentCollection(path))));
      await expectAllWritesDenied(db, path);
    });

    it('lets the owner read (get and list)', async () => {
      const db = dbFor('owner');
      await assertSucceeds(getDoc(doc(db, path)));
      await assertSucceeds(getDocs(collection(db, parentCollection(path))));
    });

    it('denies the owner every write that does not match an allowed shape', async () => {
      await expectAllWritesDenied(dbFor('owner'), path);
    });
  });

  it.each(UNKNOWN_DOCS)('denies everyone, owner included, on unknown path %s', async (path) => {
    for (const who of ['anon', 'stranger', 'owner'] as const) {
      await assertFails(getDoc(doc(dbFor(who), path)));
      await expectAllWritesDenied(dbFor(who), path);
    }
  });

  it('denies the owner schema-valid writes to Admin-only documents', async () => {
    const db = dbFor('owner');
    const at = { createdAt: serverTimestamp(), updatedAt: serverTimestamp(), schemaVersion: 1 };
    const usage = { spendPence: 0, capPence: 1500, reservations: {}, calls: {}, tokens: {} };
    await assertFails(setDoc(doc(db, 'usage/2026-10'), { ...usage, byPurpose: {}, ...at }));
    await assertFails(updateDoc(doc(db, 'usage/2026-09'), { spendPence: 0 }));
    const document = {
      kind: 'pdf',
      storagePath: 'profile/documents/doc-2/cv.pdf',
      status: 'parsed',
      ...at,
    };
    await assertFails(setDoc(doc(db, 'profile/main/documents/doc-2'), document));
    await assertFails(updateDoc(doc(db, 'profile/main/documents/doc-1'), { status: 'parsed' }));
    // M3 scan records (ADR-029): jobs, source health and the scan lock are Admin-only.
    await assertFails(updateDoc(doc(db, 'jobs/job-1'), { status: 'applied' }));
    await assertFails(setDoc(doc(db, 'sources/adzuna'), { status: 'ok', ...at }));
    await assertFails(setDoc(doc(db, DOCS.scanLock), { schemaVersion: 1 }));
  });

  it('does not let a stranger overwrite config/app to claim ownership', async () => {
    await assertFails(
      setDoc(doc(dbFor('stranger'), DOCS.appConfig), { ownerUid: STRANGER, schemaVersion: 1 }),
    );
    await assertFails(updateDoc(doc(dbFor('stranger'), DOCS.appConfig), { ownerUid: STRANGER }));
  });

  it('does not let the owner change ownerUid from the client', async () => {
    await assertFails(updateDoc(doc(dbFor('owner'), DOCS.appConfig), { ownerUid: STRANGER }));
  });
});

describe('bootstrap: before config/app exists (fails closed)', () => {
  beforeEach(async () => {
    await env.clearFirestore();
    await seed({ appConfig: null });
  });

  it.each(DATA_MODEL_DOCS)('denies every signed-in user reading %s', async (path) => {
    await assertFails(getDoc(doc(dbFor('owner'), path)));
    await assertFails(getDoc(doc(dbFor('stranger'), path)));
  });

  it('does not let a signed-in user create config/app to claim ownership', async () => {
    await assertFails(
      setDoc(doc(dbFor('stranger'), DOCS.appConfig), { ownerUid: STRANGER, schemaVersion: 1 }),
    );
  });
});

describe('bootstrap: malformed config/app never matches', () => {
  it.each([
    ['missing ownerUid', { schemaVersion: 1 }],
    ['empty ownerUid', { ownerUid: '', schemaVersion: 1 }],
    ['non-string ownerUid', { ownerUid: 42, schemaVersion: 1 }],
  ])('%s: denies every signed-in user', async (_name, appConfig) => {
    await env.clearFirestore();
    await seed({ appConfig });
    for (const who of ['owner', 'stranger'] as const) {
      await assertFails(getDoc(doc(dbFor(who), DOCS.profileMain)));
      await assertFails(getDoc(doc(dbFor(who), DOCS.appConfig)));
    }
  });
});
