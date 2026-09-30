/**
 * Criteria version rules (PRD R3, ADR-019). Run with `npm run test:rules`.
 * `criteria/v{n}` is created (never changed) in the same batch that moves `criteria/current`
 * from n-1 to n. Only the owner can do either.
 */
import { readFileSync } from 'node:fs';

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { CRITERIA_SEED_V1, DOCS, PATHS } from '@hireframe/shared';
import {
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

import { buildCriteriaWrite } from '../../web/src/services/fact-writes.ts';

const OWNER = 'owner-uid';
const STRANGER = 'stranger-uid';
const AT = Timestamp.fromDate(new Date('2026-10-01T09:00:00Z'));

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

type TestFirestore = ReturnType<RulesTestContext['firestore']>;

function dbFor(who: 'anon' | 'stranger' | 'owner'): TestFirestore {
  if (who === 'anon') return env.unauthenticatedContext().firestore();
  return env.authenticatedContext(who === 'owner' ? OWNER : STRANGER).firestore();
}

/** Seeds the owner and, optionally, criteria v1..v{latest} with the pointer at `latest`. */
async function seed(options: { withOwner?: boolean; latest?: number } = {}): Promise<void> {
  const { withOwner = true, latest = 0 } = options;
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    if (withOwner) await setDoc(doc(db, DOCS.appConfig), { ownerUid: OWNER, schemaVersion: 1 });
    for (let version = 1; version <= latest; version++) {
      await setDoc(doc(db, PATHS.criteriaVersion(`v${String(version)}`)), {
        ...CRITERIA_SEED_V1,
        version,
        createdAt: AT,
        schemaVersion: 1,
      });
    }
    if (latest > 0) {
      await setDoc(doc(db, DOCS.criteriaCurrent), {
        version: latest,
        updatedAt: AT,
        schemaVersion: 1,
      });
    }
  });
}

function versionDoc(version: number, patch: DocumentData = {}): DocumentData {
  return {
    ...CRITERIA_SEED_V1,
    version,
    createdAt: serverTimestamp(),
    schemaVersion: 1,
    ...patch,
  };
}

interface SaveOptions {
  version: number;
  versionId?: string;
  pointerVersion?: number;
  patch?: DocumentData;
  withVersion?: boolean;
  withPointer?: boolean;
}

/** One client batch: create `criteria/v{n}` and move the pointer to n. */
function save(db: TestFirestore, options: SaveOptions): Promise<void> {
  const { version, withVersion = true, withPointer = true } = options;
  const batch = writeBatch(db);
  if (withVersion) {
    batch.set(
      doc(db, PATHS.criteriaVersion(options.versionId ?? `v${String(version)}`)),
      versionDoc(version, options.patch),
    );
  }
  if (withPointer) {
    batch.set(doc(db, DOCS.criteriaCurrent), {
      version: options.pointerVersion ?? version,
      updatedAt: serverTimestamp(),
      schemaVersion: 1,
    });
  }
  return batch.commit();
}

describe('seeding criteria v1 (owner)', () => {
  beforeEach(async () => {
    await seed();
  });

  it('allows v1 plus the pointer in one batch', async () => {
    await assertSucceeds(save(dbFor('owner'), { version: 1 }));
  });

  it('denies v1 without the pointer, and the pointer without v1', async () => {
    await assertFails(save(dbFor('owner'), { version: 1, withPointer: false }));
    await assertFails(save(dbFor('owner'), { version: 1, withVersion: false }));
  });

  it('denies seeding v2 first', async () => {
    await assertFails(save(dbFor('owner'), { version: 2 }));
  });
});

describe('saving a new criteria version (owner)', () => {
  beforeEach(async () => {
    await seed({ latest: 1 });
  });

  it('allows v2 plus the pointer bump, with edited values', async () => {
    await assertSucceeds(
      save(dbFor('owner'), {
        version: 2,
        patch: { freshness_days: 21, wildcards: ['AI operations'] },
      }),
    );
  });

  it('denies skipping to v3', async () => {
    await assertFails(save(dbFor('owner'), { version: 3 }));
  });

  it('denies a version whose number does not match its ID or the pointer', async () => {
    await assertFails(save(dbFor('owner'), { version: 2, versionId: 'v7' }));
    await assertFails(save(dbFor('owner'), { version: 2, pointerVersion: 3 }));
    await assertFails(save(dbFor('owner'), { version: 2, patch: { version: 5 } }));
  });

  it('denies overwriting or deleting an existing version', async () => {
    const db = dbFor('owner');
    await assertFails(setDoc(doc(db, PATHS.criteriaVersion('v1')), versionDoc(1)));
    await assertFails(updateDoc(doc(db, PATHS.criteriaVersion('v1')), { freshness_days: 30 }));
    await assertFails(deleteDoc(doc(db, PATHS.criteriaVersion('v1'))));
  });

  it('denies moving the pointer backwards or deleting it', async () => {
    const db = dbFor('owner');
    await assertFails(
      setDoc(doc(db, DOCS.criteriaCurrent), {
        version: 1,
        updatedAt: serverTimestamp(),
        schemaVersion: 1,
      }),
    );
    await assertFails(deleteDoc(doc(db, DOCS.criteriaCurrent)));
  });

  it('denies extra pointer fields and a client-chosen updatedAt', async () => {
    const db = dbFor('owner');
    const batch = writeBatch(db);
    batch.set(doc(db, PATHS.criteriaVersion('v2')), versionDoc(2));
    batch.set(doc(db, DOCS.criteriaCurrent), { version: 2, updatedAt: AT, schemaVersion: 1 });
    await assertFails(batch.commit());

    const extra = writeBatch(db);
    extra.set(doc(db, PATHS.criteriaVersion('v2')), versionDoc(2));
    extra.set(doc(db, DOCS.criteriaCurrent), {
      version: 2,
      updatedAt: serverTimestamp(),
      schemaVersion: 1,
      note: 'x',
    });
    await assertFails(extra.commit());
  });

  it.each([
    ['an unknown key', { extra: true }],
    ['a string experience cap', { experience_cap_years: '2' }],
    ['a fractional freshness window', { freshness_days: 14.5 }],
    ['freshness above 90 days', { freshness_days: 91 }],
    ['lanes without secondary', { lanes: { primary: [], opportunistic: [] } }],
    ['a client-chosen createdAt', { createdAt: AT }],
    ['a non-list wildcards field', { wildcards: 'AI' }],
  ])('denies a version with %s', async (_name, patch) => {
    await assertFails(save(dbFor('owner'), { version: 2, patch }));
  });

  it('denies a version with a missing key', async () => {
    const db = dbFor('owner');
    const withoutTarget = versionDoc(2);
    delete withoutTarget.weekly_target;
    const batch = writeBatch(db);
    batch.set(doc(db, PATHS.criteriaVersion('v2')), withoutTarget);
    batch.set(doc(db, DOCS.criteriaCurrent), {
      version: 2,
      updatedAt: serverTimestamp(),
      schemaVersion: 1,
    });
    await assertFails(batch.commit());
  });

  it('never applies version rules to criteria/current itself', async () => {
    await assertFails(setDoc(doc(dbFor('owner'), DOCS.criteriaCurrent), versionDoc(2)));
  });
});

describe('criteria writes (not the owner)', () => {
  it.each(['anon', 'stranger'] as const)('denies %s seeding and saving', async (who) => {
    await seed();
    await assertFails(save(dbFor(who), { version: 1 }));
    await seed({ latest: 1 });
    await assertFails(save(dbFor(who), { version: 2 }));
  });

  it('denies the owner before config/app exists (fails closed)', async () => {
    await seed({ withOwner: false });
    await assertFails(save(dbFor('owner'), { version: 1 }));
  });
});

describe('writes built by web/src/services/fact-writes.ts', () => {
  it('passes the rules for seeding v1 and saving v2', async () => {
    await seed();
    const db = dbFor('owner');
    for (const version of [1, 2]) {
      const write = buildCriteriaWrite(
        { ...CRITERIA_SEED_V1, freshness_days: 10 + version },
        version,
        serverTimestamp(),
      );
      const batch = writeBatch(db);
      batch.set(doc(db, PATHS.criteriaVersion(write.versionId)), write.versionDoc);
      batch.set(doc(db, DOCS.criteriaCurrent), write.pointerDoc);
      await assertSucceeds(batch.commit());
    }
  });
});
