/**
 * Application pipeline rules (M7, ADR-055). Run with `npm run test:rules`.
 * The stage machine is server-side; the one client write on `applications/{jobId}` is the
 * Applied mirror (`stage`, `stageBefore`, `updatedAt`), allowed only in the batch that changes the
 * job's own status. `profile/cvHeader` is an owner setting with exact keys and https links.
 * The job side of each batch runs the real builder (web/src/services/job-writes.ts).
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

import { buildJobStatusWrite } from '../../web/src/services/job-writes.ts';

const OWNER = 'owner-uid';
const STRANGER = 'stranger-uid';
const JOB_ID = 'job-1';
const CREATED = Timestamp.fromDate(new Date('2026-10-01T09:00:00Z'));
const NOW = serverTimestamp();

function seededJob(extra: DocumentData = {}): DocumentData {
  return {
    dedupeKey: 'd:1',
    keys: ['d:1'],
    title: 'Product Analyst',
    company: 'Acme Analytics',
    location: 'London, UK',
    city: 'london',
    country: 'GB',
    remote: 'unknown',
    url: 'https://jobs.example.com/1',
    sources: [
      { id: 'greenhouse', url: 'https://jobs.example.com/1', externalId: '1', seenAt: CREATED },
    ],
    firstSeenAt: CREATED,
    descriptionRef: `jobs/${JOB_ID}/description/raw`,
    descriptionKind: 'full',
    stage: 's3',
    status: 'new',
    verdict: 'apply',
    fitScore: 8,
    luckScore: 6,
    reason: 'Strong match.',
    judgedAt: CREATED,
    createdAt: CREATED,
    updatedAt: CREATED,
    schemaVersion: 1,
    ...extra,
  };
}

/** An application as the server writes it (fake data). */
function seededApplication(extra: DocumentData = {}): DocumentData {
  return {
    jobId: JOB_ID,
    job: { title: 'Product Analyst', company: 'Acme Analytics', verdict: 'apply' },
    stage: 'ready',
    stageAt: CREATED,
    startedAt: CREATED,
    updatedAt: CREATED,
    questions: [],
    attempt: 0,
    cvIds: [],
    schemaVersion: 1,
    ...extra,
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
type Who = 'anon' | 'stranger' | 'owner';

function dbFor(who: Who): TestFirestore {
  if (who === 'anon') return env.unauthenticatedContext().firestore();
  return env.authenticatedContext(who === 'owner' ? OWNER : STRANGER).firestore();
}

async function seed(job: DocumentData, application: DocumentData | null): Promise<void> {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, DOCS.appConfig), { ownerUid: OWNER, schemaVersion: 1 });
    await setDoc(doc(db, PATHS.job(JOB_ID)), job);
    if (application) await setDoc(doc(db, PATHS.application(JOB_ID)), application);
  });
}

async function readApplication(): Promise<DocumentData | undefined> {
  let data: DocumentData | undefined;
  await env.withSecurityRulesDisabled(async (ctx) => {
    data = (await getDoc(doc(ctx.firestore(), PATHS.application(JOB_ID)))).data();
  });
  return data;
}

/** The batch the app commits: the job change, its event and the mirror update. */
function markApplied(db: TestFirestore, mirror: DocumentData): Promise<void> {
  const write = buildJobStatusWrite(JOB_ID, seededJob(), 'applied', NOW);
  return writeBatch(db)
    .update(doc(db, PATHS.job(JOB_ID)), write.update)
    .set(doc(db, 'events/event-1'), write.event)
    .update(doc(db, PATHS.application(JOB_ID)), mirror)
    .commit();
}

function undoApplied(db: TestFirestore, mirror: DocumentData): Promise<void> {
  const raw = seededJob({ status: 'applied', appliedAt: CREATED, appliedVerdict: 'apply' });
  const write = buildJobStatusWrite(JOB_ID, raw, 'new', NOW);
  return writeBatch(db)
    .update(doc(db, PATHS.job(JOB_ID)), write.update)
    .set(doc(db, 'events/event-2'), write.event)
    .update(doc(db, PATHS.application(JOB_ID)), mirror)
    .commit();
}

const APPLIED_JOB = seededJob({ status: 'applied', appliedAt: CREATED, appliedVerdict: 'apply' });

describe('the Applied mirror on applications/{jobId}', () => {
  beforeEach(async () => {
    await seed(seededJob(), seededApplication());
  });

  it('lets the owner set applied beside the job change, remembering the stage', async () => {
    await assertSucceeds(
      markApplied(dbFor('owner'), { stage: 'applied', stageBefore: 'ready', updatedAt: NOW }),
    );
    expect(await readApplication()).toMatchObject({ stage: 'applied', stageBefore: 'ready' });
  });

  it.each(['chosen', 'needs_input', 'generating', 'ready'] as const)(
    'allows applied from %s',
    async (stage) => {
      await seed(seededJob(), seededApplication({ stage }));
      await assertSucceeds(
        markApplied(dbFor('owner'), { stage: 'applied', stageBefore: stage, updatedAt: NOW }),
      );
    },
  );

  it('lets the owner undo, back to exactly the stage it came from', async () => {
    await seed(APPLIED_JOB, seededApplication({ stage: 'applied', stageBefore: 'generating' }));
    await assertSucceeds(
      undoApplied(dbFor('owner'), {
        stage: 'generating',
        stageBefore: deleteField(),
        updatedAt: NOW,
      }),
    );
    const application = await readApplication();
    expect(application?.stage).toBe('generating');
    expect('stageBefore' in (application ?? {})).toBe(false);
  });

  it('denies the mirror without the job’s own change', async () => {
    const db = dbFor('owner');
    await assertFails(
      updateDoc(doc(db, PATHS.application(JOB_ID)), {
        stage: 'applied',
        stageBefore: 'ready',
        updatedAt: NOW,
      }),
    );
    // A batch that leaves the job where it was is the same thing.
    await assertFails(
      writeBatch(db)
        .update(doc(db, PATHS.job(JOB_ID)), { feedback: deleteField(), updatedAt: NOW })
        .update(doc(db, PATHS.application(JOB_ID)), {
          stage: 'applied',
          stageBefore: 'ready',
          updatedAt: NOW,
        })
        .commit(),
    );
  });

  it('denies undoing without the job leaving applied, or going to another stage', async () => {
    await seed(APPLIED_JOB, seededApplication({ stage: 'applied', stageBefore: 'ready' }));
    const db = dbFor('owner');
    await assertFails(
      updateDoc(doc(db, PATHS.application(JOB_ID)), {
        stage: 'ready',
        stageBefore: deleteField(),
        updatedAt: NOW,
      }),
    );
    await assertFails(
      undoApplied(db, { stage: 'generating', stageBefore: deleteField(), updatedAt: NOW }),
    );
    await assertFails(undoApplied(db, { stage: 'ready', updatedAt: NOW })); // keeps stageBefore
  });

  it('denies any stage change that is not the mirror', async () => {
    const db = dbFor('owner');
    for (const stage of ['generating', 'withdrawn', 'chosen']) {
      await assertFails(updateDoc(doc(db, PATHS.application(JOB_ID)), { stage, updatedAt: NOW }));
    }
  });

  it('denies applied with the wrong stageBefore, or from withdrawn', async () => {
    await assertFails(
      markApplied(dbFor('owner'), { stage: 'applied', stageBefore: 'chosen', updatedAt: NOW }),
    );
    await assertFails(markApplied(dbFor('owner'), { stage: 'applied', updatedAt: NOW }));
    await seed(seededJob(), seededApplication({ stage: 'withdrawn' }));
    await assertFails(
      markApplied(dbFor('owner'), { stage: 'applied', stageBefore: 'withdrawn', updatedAt: NOW }),
    );
  });

  it('denies touching any other field, even beside a valid mirror', async () => {
    for (const extra of [
      { notes: 'sneaky' },
      { attempt: 1 },
      { currentCvId: 'job-1-v9' },
      { cvIds: ['job-1-v9'] },
      { stageAt: NOW },
      { questions: [{ id: 'q-0123456789ab' }] },
      { blocked: { code: 'cap', at: NOW } },
    ]) {
      await assertFails(
        markApplied(dbFor('owner'), {
          stage: 'applied',
          stageBefore: 'ready',
          updatedAt: NOW,
          ...extra,
        }),
      );
    }
  });

  it('requires the server time on updatedAt', async () => {
    await assertFails(
      markApplied(dbFor('owner'), { stage: 'applied', stageBefore: 'ready', updatedAt: CREATED }),
    );
  });

  it('denies anyone but the owner', async () => {
    for (const who of ['anon', 'stranger'] as const) {
      await assertFails(
        markApplied(dbFor(who), { stage: 'applied', stageBefore: 'ready', updatedAt: NOW }),
      );
      await assertFails(getDoc(doc(dbFor(who), PATHS.application(JOB_ID))));
    }
    expect((await readApplication())?.stage).toBe('ready');
  });

  it('lets the owner read, and never create or delete', async () => {
    const db = dbFor('owner');
    await assertSucceeds(getDoc(doc(db, PATHS.application(JOB_ID))));
    await assertFails(setDoc(doc(db, PATHS.application('job-2')), seededApplication()));
    await assertFails(deleteDoc(doc(db, PATHS.application(JOB_ID))));
  });

  it('denies creating an application_stage event from the client', async () => {
    const db = dbFor('owner');
    await assertFails(
      writeBatch(db)
        .update(doc(db, PATHS.job(JOB_ID)), { status: 'saved', updatedAt: NOW })
        .set(doc(db, 'events/event-3'), {
          type: 'application_stage',
          jobId: JOB_ID,
          from: null,
          to: 'chosen',
          at: NOW,
          schemaVersion: 1,
        })
        .commit(),
    );
  });
});

describe('profile/cvHeader', () => {
  const header = (extra: DocumentData = {}): DocumentData => ({
    name: 'Alex Example',
    email: 'alex@example.com',
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...extra,
  });

  beforeEach(async () => {
    await seed(seededJob(), null);
  });

  const ref = (db: TestFirestore) => doc(db, DOCS.cvHeader);

  it('lets the owner create it, with every optional field', async () => {
    await assertSucceeds(
      setDoc(
        ref(dbFor('owner')),
        header({
          phone: '020 7946 0000',
          location: 'London, UK',
          links: ['https://example.com/alex', 'https://example.org/alex'],
        }),
      ),
    );
  });

  it('lets the owner update it, keeping createdAt', async () => {
    const db = dbFor('owner');
    await assertSucceeds(setDoc(ref(db), header()));
    const created = (await getDoc(ref(db))).get('createdAt');
    await assertSucceeds(setDoc(ref(db), header({ name: 'Alex Q Example', createdAt: created })));
    await assertFails(
      setDoc(ref(db), header({ createdAt: Timestamp.fromDate(new Date('2026-01-01T00:00:00Z')) })),
    );
  });

  it('denies extra keys and missing ones', async () => {
    const db = dbFor('owner');
    await assertFails(setDoc(ref(db), header({ headline: 'Data person' })));
    const { name: _name, ...noName } = header();
    await assertFails(setDoc(ref(db), noName));
  });

  it('denies links that are not https, more than three, or not strings', async () => {
    const db = dbFor('owner');
    await assertFails(setDoc(ref(db), header({ links: ['http://example.com/alex'] })));
    await assertFails(setDoc(ref(db), header({ links: ['javascript:alert(1)'] })));
    await assertFails(setDoc(ref(db), header({ links: ['https://example.com/a b'] })));
    await assertFails(
      setDoc(
        ref(db),
        header({ links: Array.from({ length: 4 }, (_, i) => `https://example.com/${String(i)}`) }),
      ),
    );
    await assertFails(setDoc(ref(db), header({ links: 'https://example.com' })));
    await assertSucceeds(
      setDoc(
        ref(db),
        header({ links: Array.from({ length: 3 }, (_, i) => `https://example.com/${String(i)}`) }),
      ),
    );
  });

  it('denies blank or oversized fields and a bad email', async () => {
    const db = dbFor('owner');
    await assertFails(setDoc(ref(db), header({ name: '   ' })));
    await assertFails(setDoc(ref(db), header({ name: 'x'.repeat(81) })));
    await assertFails(setDoc(ref(db), header({ email: 'not-an-email' })));
    await assertFails(setDoc(ref(db), header({ phone: '' })));
    await assertFails(setDoc(ref(db), header({ location: 'x'.repeat(81) })));
  });

  it('requires the server time and the schema version', async () => {
    const db = dbFor('owner');
    await assertFails(setDoc(ref(db), header({ updatedAt: CREATED, createdAt: CREATED })));
    await assertFails(setDoc(ref(db), header({ schemaVersion: 2 })));
  });

  it('denies anyone but the owner, and delete for everyone', async () => {
    for (const who of ['anon', 'stranger'] as const) {
      await assertFails(setDoc(ref(dbFor(who)), header()));
      await assertFails(getDoc(ref(dbFor(who))));
    }
    const db = dbFor('owner');
    await assertSucceeds(setDoc(ref(db), header()));
    await assertSucceeds(getDoc(ref(db)));
    await assertFails(deleteDoc(ref(db)));
    expect(await getDoc(ref(db))).toBeDefined();
  });

  it('leaves profile/main rules as they were: a header body there is refused', async () => {
    await assertFails(setDoc(doc(dbFor('owner'), DOCS.profileMain), header()));
  });
});
