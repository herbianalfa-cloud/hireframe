/**
 * Fact edit rules (PRD R2 "edits are versioned", ADR-018). Run with `npm run test:rules`.
 * The owner may update a fact only as a new version: bump `version`, set `updatedAt` to the
 * server time and write the matching snapshot in the same batch. `review` can only be removed
 * (accept or keep a proposed change). Facts are never created or deleted from the client.
 * "Remove upload" (ADR-023) may only stamp `removedAt` on a finished upload document.
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
  getDoc,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildAcceptReview,
  buildFactWrite,
  buildKeepReview,
  buildCvHeaderWrite,
  buildUploadRemoval,
  buildWorkRightsWrite,
  type FactWrite,
} from '../../web/src/services/fact-writes.ts';

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

async function seed(
  options: { withOwner?: boolean; withReview?: boolean; extra?: DocumentData } = {},
): Promise<void> {
  const { withOwner = true, withReview = false, extra = {} } = options;
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    if (withOwner) await setDoc(doc(db, DOCS.appConfig), { ownerUid: OWNER, schemaVersion: 1 });
    await setDoc(doc(db, PATHS.fact(FACT_ID)), { ...seededFact(withReview), ...extra });
    await setDoc(doc(db, PATHS.factVersion(FACT_ID, 1)), {
      snapshot: { ...seededFact(false), ...extra },
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

describe('evidence links (ADR-024)', () => {
  const LINK = 'https://example.com/portfolio';

  beforeEach(async () => {
    await seed();
  });

  it('allows the owner to add a link as a new version', async () => {
    await assertSucceeds(edit(dbFor('owner'), { factPatch: { evidenceUrl: LINK, ...bump } }));
  });

  it('allows changing and removing a link', async () => {
    await seed({ extra: { evidenceUrl: LINK } });
    const changed = 'https://example.org/certificate';
    await assertSucceeds(
      edit(dbFor('owner'), {
        factPatch: { evidenceUrl: changed, ...bump },
        snapshot: factAfter({ evidenceUrl: changed }),
      }),
    );
    await seed({ extra: { evidenceUrl: LINK } });
    await assertSucceeds(
      edit(dbFor('owner'), {
        factPatch: { evidenceUrl: deleteField(), ...bump },
        snapshot: factAfter({}),
      }),
    );
  });

  it.each([
    ['http', 'http://example.com'],
    ['a javascript: link', 'javascript:alert(1)'],
    ['a link with whitespace', 'https://example.com/a b'],
    ['a bare scheme', 'https://'],
    ['an oversized link', `https://example.com/${'a'.repeat(481)}`],
    ['a non-string', 42],
  ])('denies %s', async (_name, evidenceUrl) => {
    await assertFails(edit(dbFor('owner'), { factPatch: { evidenceUrl, ...bump } }));
  });

  it('denies a link without the snapshot, or with a snapshot that lacks it', async () => {
    await assertFails(
      edit(dbFor('owner'), { factPatch: { evidenceUrl: LINK, ...bump }, withSnapshot: false }),
    );
    await assertFails(
      edit(dbFor('owner'), { factPatch: { evidenceUrl: LINK, ...bump }, snapshot: factAfter({}) }),
    );
  });

  it.each(['anon', 'stranger'] as const)('denies %s', async (who) => {
    await assertFails(edit(dbFor(who), { factPatch: { evidenceUrl: LINK, ...bump } }));
  });

  it('denies the owner before config/app exists (fails closed)', async () => {
    await seed({ withOwner: false });
    await assertFails(edit(dbFor('owner'), { factPatch: { evidenceUrl: LINK, ...bump } }));
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

describe('batches built by web/src/services/fact-writes.ts', () => {
  async function commit(build: (raw: DocumentData) => FactWrite): Promise<void> {
    const db = dbFor('owner');
    const snapshot = await getDoc(doc(db, PATHS.fact(FACT_ID)));
    const write = build(snapshot.data() ?? {});
    const batch = writeBatch(db);
    batch.update(doc(db, PATHS.fact(FACT_ID)), write.update);
    batch.set(doc(db, PATHS.factVersion(FACT_ID, write.version)), {
      snapshot: write.snapshot,
      change: write.change,
      at: serverTimestamp(),
    });
    await batch.commit();
  }

  it('passes the rules for edit, archive and unarchive in sequence', async () => {
    await seed();
    await assertSucceeds(
      commit((raw) => buildFactWrite(raw, { text: 'Edited' }, 'edit', serverTimestamp())),
    );
    await assertSucceeds(
      commit((raw) => buildFactWrite(raw, { status: 'archived' }, 'archive', serverTimestamp())),
    );
    await assertSucceeds(
      commit((raw) => buildFactWrite(raw, { status: 'active' }, 'unarchive', serverTimestamp())),
    );
  });

  it('passes the rules for adding, then removing, an evidence link', async () => {
    await seed();
    const link = 'https://example.com/portfolio';
    await assertSucceeds(
      commit((raw) => buildFactWrite(raw, { evidenceUrl: link }, 'edit', serverTimestamp())),
    );
    await assertSucceeds(
      commit((raw) => buildFactWrite(raw, { evidenceUrl: null }, 'edit', serverTimestamp())),
    );
    const after = await getDoc(doc(dbFor('owner'), PATHS.fact(FACT_ID)));
    expect(after.data()).not.toHaveProperty('evidenceUrl');
  });

  it('passes the rules for accepting a proposed change', async () => {
    await seed({ withReview: true });
    await assertSucceeds(commit((raw) => buildAcceptReview(raw, serverTimestamp())));
  });

  it('passes the rules for keeping the current fact', async () => {
    await seed({ withReview: true });
    await assertSucceeds(commit((raw) => buildKeepReview(raw, serverTimestamp())));
  });
});

describe('removing an upload (ADR-023)', () => {
  const DOC_ID = 'abcdefghij0123456789';
  const OTHER_FACT = 'fact-2';
  const document = (overrides: DocumentData = {}): DocumentData => ({
    kind: 'pdf',
    storagePath: `profile/documents/${DOC_ID}/cv.pdf`,
    status: 'parsed',
    sha256: 'a'.repeat(64),
    summary: { added: 1 },
    createdAt: CREATED,
    updatedAt: CREATED,
    schemaVersion: 1,
    ...overrides,
  });
  const mark = { removedAt: serverTimestamp(), updatedAt: serverTimestamp() };

  /** fact-1 was added by the upload; fact-2 is older and has a proposed change from it. */
  async function seedUpload(overrides: DocumentData = {}, withOwner = true): Promise<void> {
    await seed({ withOwner });
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, PATHS.document(DOC_ID)), document(overrides));
      const older = {
        ...seededFact(true),
        sourceDocId: 'zyxwvutsrq9876543210',
        version: 3,
      };
      await setDoc(doc(db, PATHS.fact(OTHER_FACT)), older);
    });
  }

  const docRef = (db: TestFirestore, path = PATHS.document(DOC_ID)) => doc(db, path);

  it.each(['parsed', 'failed'])('allows the owner to mark a %s upload removed', async (status) => {
    await seedUpload({ status });
    await assertSucceeds(updateDoc(docRef(dbFor('owner')), mark));
  });

  it('denies an upload that is still being read', async () => {
    await seedUpload({ status: 'parsing' });
    await assertFails(updateDoc(docRef(dbFor('owner')), mark));
  });

  it('denies removing twice', async () => {
    await seedUpload({ removedAt: CREATED });
    await assertFails(updateDoc(docRef(dbFor('owner')), mark));
  });

  it('denies a client-chosen time or a mark without updatedAt', async () => {
    await seedUpload();
    const at = Timestamp.fromDate(new Date('2026-10-02T09:00:00Z'));
    await assertFails(updateDoc(docRef(dbFor('owner')), { removedAt: at, updatedAt: at }));
    await assertFails(updateDoc(docRef(dbFor('owner')), { removedAt: serverTimestamp() }));
  });

  it.each([
    ['status', { status: 'failed' }],
    ['summary', { summary: { added: 0 } }],
    ['sha256', { sha256: 'b'.repeat(64) }],
    ['fileName', { fileName: 'other.pdf' }],
    ['duplicateOf', { duplicateOf: 'zyxwvutsrq9876543210' }],
    ['storagePath', { storagePath: 'elsewhere' }],
  ])('denies also changing %s', async (_name, patch) => {
    await seedUpload();
    await assertFails(updateDoc(docRef(dbFor('owner')), { ...mark, ...patch }));
  });

  it('denies changing a document without removing it', async () => {
    await seedUpload();
    await assertFails(updateDoc(docRef(dbFor('owner')), { status: 'failed' }));
  });

  it('denies creating or deleting a document', async () => {
    await seedUpload();
    const db = dbFor('owner');
    await assertFails(
      setDoc(docRef(db, PATHS.document('zyxwvutsrq9876543210')), document({ ...mark })),
    );
    await assertFails(deleteDoc(docRef(db)));
  });

  it('denies documents outside profile/main', async () => {
    await seedUpload();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `profile/other/documents/${DOC_ID}`), document());
    });
    await assertFails(updateDoc(docRef(dbFor('owner'), `profile/other/documents/${DOC_ID}`), mark));
  });

  it.each(['anon', 'stranger'] as const)('denies %s', async (who) => {
    await seedUpload();
    await assertFails(updateDoc(docRef(dbFor(who)), mark));
  });

  it('denies the owner before config/app exists (fails closed)', async () => {
    await seedUpload({}, false);
    await assertFails(updateDoc(docRef(dbFor('owner')), mark));
  });

  describe('batches built by buildUploadRemoval', () => {
    /** Builds the removal from the stored facts; the returned function commits it. */
    async function buildRemoval(db: TestFirestore): Promise<() => Promise<void>> {
      const rawById = new Map<string, DocumentData>();
      for (const id of [FACT_ID, OTHER_FACT]) {
        rawById.set(id, (await getDoc(doc(db, PATHS.fact(id)))).data() ?? {});
      }
      const plan = { archive: [FACT_ID], dropReviews: [OTHER_FACT], skippedEdited: 0 };
      const removals = buildUploadRemoval(plan, rawById, serverTimestamp());
      return async () => {
        for (const removal of removals) {
          const batch = writeBatch(db);
          for (const { factId, write } of removal.facts) {
            batch.update(doc(db, PATHS.fact(factId)), write.update);
            batch.set(doc(db, PATHS.factVersion(factId, write.version)), {
              snapshot: write.snapshot,
              change: write.change,
              at: serverTimestamp(),
            });
          }
          if (removal.document) batch.update(docRef(db), removal.document);
          await batch.commit();
        }
      };
    }

    it('archive + drop proposed change + document mark pass the rules', async () => {
      await seedUpload();
      const db = dbFor('owner');
      await assertSucceeds((await buildRemoval(db))());
      const [added, older] = await Promise.all([
        getDoc(doc(db, PATHS.fact(FACT_ID))),
        getDoc(doc(db, PATHS.fact(OTHER_FACT))),
      ]);
      expect(added.data()).toMatchObject({ status: 'archived', version: 2 });
      expect(older.data()).toMatchObject({ status: 'active', version: 4 });
      expect(older.data()).not.toHaveProperty('review');
    });

    it('replaying the same removal is denied', async () => {
      await seedUpload();
      const db = dbFor('owner');
      const commit = await buildRemoval(db);
      await commit();
      await assertFails(commit());
    });
  });
});

describe('CV header on profile/cvHeader (M7 7D.3)', () => {
  const header = () => doc(dbFor('owner'), DOCS.cvHeader);
  const values = {
    name: 'Alex Example',
    email: 'alex@example.com',
    phone: '',
    location: 'London, UK',
    links: ['https://example.com/alex', '', ''] as const,
  };

  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), DOCS.appConfig), { ownerUid: OWNER, schemaVersion: 1 });
    });
  });

  it('lets the owner create it and then update it with the web builder, keeping createdAt', async () => {
    await assertSucceeds(
      setDoc(header(), buildCvHeaderWrite(values, undefined, serverTimestamp())),
    );
    const created = (await getDoc(header())).data();
    expect(created && 'phone' in created).toBe(false);
    expect(created?.links).toEqual(['https://example.com/alex']);

    await assertSucceeds(
      setDoc(
        header(),
        buildCvHeaderWrite(
          { ...values, name: 'Alex Q Example', links: ['', '', ''] },
          created?.createdAt,
          serverTimestamp(),
        ),
      ),
    );
    const updated = (await getDoc(header())).data();
    expect(updated?.name).toBe('Alex Q Example');
    // A field left empty is gone, not an empty string.
    expect(updated && 'links' in updated).toBe(false);
    expect(updated?.createdAt).toEqual(created?.createdAt);
  });

  it('is refused when createdAt is not the stored value (the builder cannot create over it)', async () => {
    await assertSucceeds(
      setDoc(header(), buildCvHeaderWrite(values, undefined, serverTimestamp())),
    );
    await assertFails(setDoc(header(), buildCvHeaderWrite(values, undefined, serverTimestamp())));
  });
});

describe('work-rights setting on profile/main (ADR-033)', () => {
  const settings = () => doc(dbFor('owner'), DOCS.profileMain);

  async function seedOwnerOnly(): Promise<void> {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), DOCS.appConfig), { ownerUid: OWNER, schemaVersion: 1 });
    });
  }

  beforeEach(async () => {
    await seedOwnerOnly();
  });

  it('lets the owner create, change and clear it with the web builder', async () => {
    await assertSucceeds(
      setDoc(
        settings(),
        buildWorkRightsWrite(
          { workRights: 'time_limited', validUntil: '2028-06-30' },
          false,
          serverTimestamp(),
        ),
        { merge: true },
      ),
    );
    await assertSucceeds(
      setDoc(
        settings(),
        buildWorkRightsWrite({ workRights: 'needs_sponsorship' }, true, serverTimestamp()),
        {
          merge: true,
        },
      ),
    );
    const stored = (await getDoc(settings())).data();
    expect(stored?.workRights).toBe('needs_sponsorship');
    expect(stored && 'validUntil' in stored).toBe(false);
    expect(stored?.createdAt).toBeDefined();
  });

  it.each([
    ['an unknown value', { workRights: 'citizen' }],
    ['a bad date', { validUntil: '30/06/2028' }],
    ['an extra key', { note: 'x' }],
    ['a client-chosen updatedAt', { updatedAt: CREATED }],
    ['a client-chosen createdAt', { createdAt: CREATED }],
  ])('denies %s', async (_name, patch) => {
    await assertFails(
      setDoc(settings(), {
        workRights: 'time_limited',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        schemaVersion: 1,
        ...patch,
      }),
    );
  });

  it('denies changing createdAt on update, and deleting the document', async () => {
    await assertSucceeds(
      setDoc(
        settings(),
        buildWorkRightsWrite({ workRights: 'unrestricted' }, false, serverTimestamp()),
        { merge: true },
      ),
    );
    await assertFails(
      updateDoc(settings(), { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }),
    );
    await assertFails(deleteDoc(settings()));
  });

  it.each(['anon', 'stranger'] as const)('denies %s', async (who) => {
    await assertFails(
      setDoc(
        doc(dbFor(who), DOCS.profileMain),
        buildWorkRightsWrite({ workRights: 'unrestricted' }, false, serverTimestamp()),
        { merge: true },
      ),
    );
  });

  it('only allows profile/main, not other profile documents', async () => {
    await assertFails(
      setDoc(
        doc(dbFor('owner'), 'profile/other'),
        buildWorkRightsWrite({ workRights: 'unrestricted' }, false, serverTimestamp()),
        { merge: true },
      ),
    );
  });
});
