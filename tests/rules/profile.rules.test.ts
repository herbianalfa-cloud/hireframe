/**
 * Fact edit rules (PRD R2 "edits are versioned", ADR-018). Run with `npm run test:rules`.
 * The owner may update a fact only as a new version: bump `version`, set `updatedAt` to the
 * server time and write the matching snapshot in the same batch. `review` can only be removed
 * (accept or keep a proposed change). Facts are never created or deleted from the client.
 */
import { readFileSync } from 'node:fs';

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { DOCS, PATHS } from '@hireframe/shared';
import {
  deleteDoc,
  deleteField,
  doc,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const OWNER = 'owner-uid';
const STRANGER = 'stranger-uid';
const FACT_ID = 'fact-1';
const CREATED = Timestamp.fromDate(new Date('2026-10-01T09:00:00Z'));

const content = {
  type: 'experience',
  text: 'Ran onboarding for new B2B clients',
  evidence: 'Ran onboarding for new B2B clients',
  dates: { start: '2024-01', end: '2025-06' },
  tags: ['onboarding'],
  lanes: ['secondary'],
  status: 'active',
};

/** A proposed change as the server stores it: fact content without `status`. */
const proposed = {
  type: content.type,
  text: 'Ran onboarding for 12 new B2B clients',
  evidence: 'Ran onboarding for 12 new B2B clients',
  dates: content.dates,
  tags: content.tags,
  lanes: content.lanes,
};

/** The fact as the server wrote it (v1), optionally with a pending review. */
function seededFact(withReview: boolean): DocumentData {
  return {
    ...content,
    source: 'cv',
    sourceDocId: 'abcdefghij0123456789',
    version: 1,
    evidenceVerified: true,
    createdAt: CREATED,
    updatedAt: CREATED,
    schemaVersion: 1,
    ...(withReview
      ? { review: { kind: 'changed', proposed, docId: 'abcdefghij0123456789', at: CREATED } }
      : {}),
  };
}

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

async function seed(options: { withOwner?: boolean; withReview?: boolean } = {}): Promise<void> {
  const { withOwner = true, withReview = false } = options;
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    if (withOwner) await setDoc(doc(db, DOCS.appConfig), { ownerUid: OWNER, schemaVersion: 1 });
    await setDoc(doc(db, PATHS.fact(FACT_ID)), seededFact(withReview));
    await setDoc(doc(db, PATHS.factVersion(FACT_ID, 1)), {
      snapshot: seededFact(false),
      change: 'created',
      at: CREATED,
    });
  });
}

/** The fact after a v2 edit, as the snapshot must record it. */
function factAfter(patch: DocumentData, options: { withReview?: boolean } = {}): DocumentData {
  return {
    ...seededFact(options.withReview ?? false),
    version: 2,
    updatedAt: serverTimestamp(),
    ...patch,
  };
}

interface EditOptions {
  factPatch: DocumentData;
  snapshot?: DocumentData;
  change?: string;
  versionId?: string;
  withSnapshot?: boolean;
}

/** One client batch: update the fact and write its snapshot. */
function edit(db: TestFirestore, options: EditOptions): Promise<void> {
  const { factPatch, change = 'edit', versionId = '2', withSnapshot = true } = options;
  const batch = writeBatch(db);
  batch.update(doc(db, PATHS.fact(FACT_ID)), factPatch);
  if (withSnapshot) {
    const snapshot = options.snapshot ?? factAfter(withoutReview(factPatch));
    batch.set(doc(db, `${PATHS.factVersions(FACT_ID)}/${versionId}`), {
      snapshot,
      change,
      at: serverTimestamp(),
    });
  }
  return batch.commit();
}

/** Drops the `review: deleteField()` sentinel so the patch can be merged into the snapshot. */
function withoutReview(patch: DocumentData): DocumentData {
  return Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'review'));
}

const bump = { version: 2, updatedAt: serverTimestamp() };

describe('fact edits (owner)', () => {
  beforeEach(async () => {
    await seed();
  });

  it('allows an edit that bumps the version and writes the matching snapshot', async () => {
    await assertSucceeds(
      edit(dbFor('owner'), { factPatch: { text: 'Ran onboarding for B2B clients', ...bump } }),
    );
  });

  it.each([
    ['archive', { status: 'archived' }],
    [
      'edit',
      { tags: ['onboarding', 'b2b'], lanes: ['primary', 'secondary'], dates: { start: '2024-02' } },
    ],
  ])('allows %s', async (change, patch) => {
    await assertSucceeds(edit(dbFor('owner'), { factPatch: { ...patch, ...bump }, change }));
  });

  it('denies an edit without the snapshot', async () => {
    await assertFails(
      edit(dbFor('owner'), { factPatch: { text: 'x', ...bump }, withSnapshot: false }),
    );
  });

  it('denies an edit that does not bump the version', async () => {
    await assertFails(
      edit(dbFor('owner'), {
        factPatch: { text: 'x', updatedAt: serverTimestamp() },
        versionId: '1',
      }),
    );
  });

  it('denies skipping a version', async () => {
    await assertFails(
      edit(dbFor('owner'), {
        factPatch: { text: 'x', version: 3, updatedAt: serverTimestamp() },
        versionId: '3',
      }),
    );
  });

  it('denies a client-chosen updatedAt', async () => {
    const at = Timestamp.fromDate(new Date('2026-10-02T09:00:00Z'));
    await assertFails(
      edit(dbFor('owner'), {
        factPatch: { text: 'x', version: 2, updatedAt: at },
        snapshot: factAfter({ text: 'x', updatedAt: at }),
      }),
    );
  });

  it.each([
    ['source', { source: 'manual' }],
    ['sourceDocId', { sourceDocId: 'zzzzzzzzzzzzzzzzzzzz' }],
    ['createdAt', { createdAt: Timestamp.now() }],
    ['evidenceVerified', { evidenceVerified: false }],
    ['schemaVersion', { schemaVersion: 2 }],
  ])('denies changing %s', async (_name, patch) => {
    await assertFails(edit(dbFor('owner'), { factPatch: { ...patch, ...bump } }));
  });

  it('denies setting a review from the client', async () => {
    const review = { kind: 'changed', proposed, docId: 'abcdefghij0123456789', at: CREATED };
    await assertFails(
      edit(dbFor('owner'), { factPatch: { review, ...bump }, snapshot: factAfter({ review }) }),
    );
  });

  it.each([
    ['an unknown type', { type: 'hobby' }],
    ['an unknown status', { status: 'deleted' }],
    ['an unknown lane', { lanes: ['dream'] }],
    ['empty text', { text: '' }],
    ['oversized text', { text: 'x'.repeat(501) }],
    ['too many tags', { tags: Array.from({ length: 21 }, (_, i) => `t${String(i)}`) }],
    ['an unknown date key', { dates: { from: '2024' } }],
  ])('denies %s', async (_name, patch) => {
    await assertFails(edit(dbFor('owner'), { factPatch: { ...patch, ...bump } }));
  });

  it('denies a snapshot that does not match the updated fact', async () => {
    await assertFails(
      edit(dbFor('owner'), {
        factPatch: { text: 'Ran onboarding for B2B clients', ...bump },
        snapshot: factAfter({ text: 'Something else' }),
      }),
    );
  });

  it('denies a snapshot with an unknown change kind', async () => {
    await assertFails(
      edit(dbFor('owner'), { factPatch: { text: 'x', ...bump }, change: 'created' }),
    );
  });

  it('denies a snapshot written without updating the fact', async () => {
    await assertFails(
      setDoc(doc(dbFor('owner'), PATHS.factVersion(FACT_ID, 2)), {
        snapshot: factAfter({}),
        change: 'edit',
        at: serverTimestamp(),
      }),
    );
  });

  it('denies overwriting or deleting a snapshot', async () => {
    const db = dbFor('owner');
    await assertFails(
      setDoc(doc(db, PATHS.factVersion(FACT_ID, 1)), {
        snapshot: {},
        change: 'edit',
        at: serverTimestamp(),
      }),
    );
    await assertFails(deleteDoc(doc(db, PATHS.factVersion(FACT_ID, 1))));
  });

  it('denies creating or deleting a fact', async () => {
    const db = dbFor('owner');
    await assertFails(setDoc(doc(db, PATHS.fact('fact-2')), factAfter({ version: 1 })));
    await assertFails(deleteDoc(doc(db, PATHS.fact(FACT_ID))));
  });

  it('denies edits outside profile/main', async () => {
    await assertFails(
      updateDoc(doc(dbFor('owner'), 'profile/other/facts/fact-1'), { text: 'x', ...bump }),
    );
  });
});

describe('accepting or keeping a flagged change', () => {
  beforeEach(async () => {
    await seed({ withReview: true });
  });

  const accept = {
    text: proposed.text,
    evidence: proposed.evidence,
    review: deleteField(),
    ...bump,
  };
  const keep = { review: deleteField(), ...bump };

  it('allows accepting: proposed fields applied, review removed, version bumped, snapshot written', async () => {
    await assertSucceeds(edit(dbFor('owner'), { factPatch: accept, change: 'review_accepted' }));
  });

  it('allows keeping the current fact: review removed, version bumped, snapshot written', async () => {
    await assertSucceeds(edit(dbFor('owner'), { factPatch: keep, change: 'review_kept' }));
  });

  it('denies accepting without a snapshot', async () => {
    await assertFails(edit(dbFor('owner'), { factPatch: accept, withSnapshot: false }));
  });

  it('denies accepting without a version bump', async () => {
    const noBump = {
      text: proposed.text,
      evidence: proposed.evidence,
      review: deleteField(),
      updatedAt: serverTimestamp(),
    };
    await assertFails(
      edit(dbFor('owner'), { factPatch: noBump, versionId: '1', change: 'review_accepted' }),
    );
  });

  it('denies accepting while leaving the review in place', async () => {
    const keepsReview = { text: proposed.text, evidence: proposed.evidence, ...bump };
    await assertFails(
      edit(dbFor('owner'), {
        factPatch: keepsReview,
        change: 'review_accepted',
        snapshot: factAfter(
          { text: proposed.text, evidence: proposed.evidence },
          { withReview: true },
        ),
      }),
    );
  });

  it('denies removing the review under a plain edit', async () => {
    await assertFails(edit(dbFor('owner'), { factPatch: keep, change: 'edit' }));
  });

  it('still allows a plain edit that leaves the pending review alone', async () => {
    await assertSucceeds(
      edit(dbFor('owner'), {
        factPatch: { tags: ['onboarding', 'b2b'], ...bump },
        snapshot: factAfter({ tags: ['onboarding', 'b2b'] }, { withReview: true }),
      }),
    );
  });

  it('denies editing the proposed change instead of removing it', async () => {
    await assertFails(
      edit(dbFor('owner'), {
        factPatch: { 'review.proposed.text': 'tampered', ...bump },
        change: 'review_accepted',
      }),
    );
  });

  it('denies accepting with a snapshot that does not match', async () => {
    await assertFails(
      edit(dbFor('owner'), {
        factPatch: accept,
        change: 'review_accepted',
        snapshot: factAfter({ text: 'not what was written' }),
      }),
    );
  });

  it('denies accepting that also changes the source or createdAt', async () => {
    await assertFails(
      edit(dbFor('owner'), {
        factPatch: { ...accept, source: 'manual' },
        change: 'review_accepted',
      }),
    );
    await assertFails(
      edit(dbFor('owner'), {
        factPatch: { ...accept, createdAt: Timestamp.now() },
        change: 'review_accepted',
      }),
    );
  });

  it.each(['anon', 'stranger'] as const)('denies %s accepting or keeping', async (who) => {
    await assertFails(edit(dbFor(who), { factPatch: accept, change: 'review_accepted' }));
    await assertFails(edit(dbFor(who), { factPatch: keep, change: 'review_kept' }));
  });
});

describe('fact edits (not the owner)', () => {
  it.each(['anon', 'stranger'] as const)('denies %s a valid edit', async (who) => {
    await seed();
    await assertFails(edit(dbFor(who), { factPatch: { text: 'x', ...bump } }));
  });

  it('denies the owner before config/app exists (fails closed)', async () => {
    await seed({ withOwner: false });
    await assertFails(edit(dbFor('owner'), { factPatch: { text: 'x', ...bump } }));
  });
});
