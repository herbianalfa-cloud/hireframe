/**
 * Job action and event rules (PRD R7, ADR-038). Run with `npm run test:rules`.
 * The owner may change a job's `status`, `appliedAt`, `appliedVerdict`, `feedback` and
 * `updatedAt` only, and append `events` in the same batch; nothing the funnel writes is editable.
 * The happy paths run the real builders (web/src/services/job-writes.ts) against the rules.
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
  buildJobFeedbackWrite,
  buildJobStatusWrite,
  type JobActionWrite,
} from '../../web/src/services/job-writes.ts';

const OWNER = 'owner-uid';
const STRANGER = 'stranger-uid';
const JOB_ID = 'job-1';
const EVENT_ID = 'event-1';
const CREATED = Timestamp.fromDate(new Date('2026-10-01T09:00:00Z'));

/** A judged job as the funnel leaves it (fake data). */
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

function withoutKeys(data: DocumentData, keys: string[]): DocumentData {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !keys.includes(key)));
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

async function seed(job: DocumentData = seededJob()): Promise<void> {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, DOCS.appConfig), { ownerUid: OWNER, schemaVersion: 1 });
    await setDoc(doc(db, PATHS.job(JOB_ID)), job);
  });
}

/** The batch the app commits: the job update and its event. */
function commit(db: TestFirestore, write: JobActionWrite, eventId = EVENT_ID): Promise<void> {
  return writeBatch(db)
    .update(doc(db, PATHS.job(JOB_ID)), write.update)
    .set(doc(db, `events/${eventId}`), write.event)
    .commit();
}

async function readJob(): Promise<DocumentData> {
  let data: DocumentData = {};
  await env.withSecurityRulesDisabled(async (ctx) => {
    data = (await getDoc(doc(ctx.firestore(), PATHS.job(JOB_ID)))).data() ?? {};
  });
  return data;
}

const NOW = serverTimestamp();

describe('status changes', () => {
  beforeEach(async () => {
    await seed();
  });

  it('lets the owner mark a job applied, stamping the time and verdict', async () => {
    const db = dbFor('owner');
    await assertSucceeds(commit(db, buildJobStatusWrite(JOB_ID, seededJob(), 'applied', NOW)));
    const job = await readJob();
    expect(job.status).toBe('applied');
    expect(job.appliedVerdict).toBe('apply');
    expect(job.appliedAt).toBeInstanceOf(Timestamp);
    expect(job.title).toBe('Product Analyst');
  });

  it('clears the applied stamps on leaving applied', async () => {
    await seed(seededJob({ status: 'applied', appliedAt: CREATED, appliedVerdict: 'apply' }));
    const raw = seededJob({ status: 'applied', appliedAt: CREATED, appliedVerdict: 'apply' });
    await assertSucceeds(commit(dbFor('owner'), buildJobStatusWrite(JOB_ID, raw, 'new', NOW)));
    const job = await readJob();
    expect(job.status).toBe('new');
    expect('appliedAt' in job).toBe(false);
    expect('appliedVerdict' in job).toBe(false);
  });

  it('lets the owner save and skip', async () => {
    const db = dbFor('owner');
    await assertSucceeds(commit(db, buildJobStatusWrite(JOB_ID, seededJob(), 'saved', NOW)));
    await assertSucceeds(
      commit(
        db,
        buildJobStatusWrite(JOB_ID, seededJob({ status: 'saved' }), 'skipped', NOW),
        'event-2',
      ),
    );
  });

  it('marks an unjudged job applied without a verdict', async () => {
    const unjudged = withoutKeys(seededJob(), ['verdict', 'judgedAt']);
    await seed(unjudged);
    await assertSucceeds(
      commit(dbFor('owner'), buildJobStatusWrite(JOB_ID, unjudged, 'applied', NOW)),
    );
    expect('appliedVerdict' in (await readJob())).toBe(false);
  });

  it('denies a status the app cannot set, and leaving a server-owned one', async () => {
    const db = dbFor('owner');
    await assertFails(updateDoc(doc(db, PATHS.job(JOB_ID)), { status: 'offer', updatedAt: NOW }));
    await seed(seededJob({ status: 'interview' }));
    await assertFails(updateDoc(doc(db, PATHS.job(JOB_ID)), { status: 'saved', updatedAt: NOW }));
  });

  it('denies applied without the server time or the job’s own verdict', async () => {
    const db = dbFor('owner');
    const ref = doc(db, PATHS.job(JOB_ID));
    const later = Timestamp.fromDate(new Date('2026-10-02T09:00:00Z'));
    await assertFails(
      updateDoc(ref, {
        status: 'applied',
        appliedAt: later,
        appliedVerdict: 'apply',
        updatedAt: NOW,
      }),
    );
    await assertFails(
      updateDoc(ref, { status: 'applied', appliedAt: NOW, appliedVerdict: 'skip', updatedAt: NOW }),
    );
    await assertFails(updateDoc(ref, { status: 'applied', appliedAt: NOW, updatedAt: NOW }));
  });

  it('denies stamping applied fields without changing the status, or keeping them on leaving', async () => {
    const db = dbFor('owner');
    const ref = doc(db, PATHS.job(JOB_ID));
    await assertFails(updateDoc(ref, { appliedAt: NOW, appliedVerdict: 'apply', updatedAt: NOW }));
    await seed(seededJob({ status: 'applied', appliedAt: CREATED, appliedVerdict: 'apply' }));
    await assertFails(updateDoc(ref, { status: 'saved', updatedAt: NOW }));
    await assertFails(
      updateDoc(ref, { status: 'saved', appliedAt: deleteField(), updatedAt: NOW }),
    );
  });

  it('requires the server time on updatedAt', async () => {
    await assertFails(
      updateDoc(doc(dbFor('owner'), PATHS.job(JOB_ID)), { status: 'saved', updatedAt: CREATED }),
    );
  });

  it('denies a job event that does not match the job change', async () => {
    const db = dbFor('owner');
    const write = buildJobStatusWrite(JOB_ID, seededJob(), 'applied', NOW);
    // Event says saved, job goes to applied.
    await assertFails(commit(db, { ...write, event: { ...write.event, to: 'saved' } }));
    // Event claims a different starting status.
    await assertFails(commit(db, { ...write, event: { ...write.event, from: 'saved' } }));
  });
});

describe('feedback', () => {
  beforeEach(async () => {
    await seed();
  });

  it('records a 👍', async () => {
    const write = buildJobFeedbackWrite(JOB_ID, seededJob(), { agree: true }, NOW);
    await assertSucceeds(commit(dbFor('owner'), write));
    expect((await readJob()).feedback).toMatchObject({ agree: true, verdict: 'apply' });
  });

  it('records a 👎 with a note and the expected verdict, and can be replaced', async () => {
    const db = dbFor('owner');
    const write = buildJobFeedbackWrite(
      JOB_ID,
      seededJob(),
      { agree: false, note: 'Needs 5 years of SQL.', expected: 'near_miss' },
      NOW,
    );
    await assertSucceeds(commit(db, write));
    expect((await readJob()).feedback).toMatchObject({
      agree: false,
      note: 'Needs 5 years of SQL.',
      expected: 'near_miss',
    });
    await assertSucceeds(
      commit(db, buildJobFeedbackWrite(JOB_ID, seededJob(), { agree: true }, NOW), 'event-2'),
    );
  });

  it('rejects a rating made against a verdict that a re-score has since changed', async () => {
    await seed(seededJob({ verdict: 'near_miss' }));
    // The screen read `apply`; the stored verdict is now `near_miss`.
    const write = buildJobFeedbackWrite(JOB_ID, seededJob(), { agree: true }, NOW);
    await assertFails(commit(dbFor('owner'), write));
  });

  it('denies a rating on a job with no verdict', async () => {
    const unjudged = withoutKeys(seededJob(), ['verdict']);
    await seed(unjudged);
    const write = buildJobFeedbackWrite(JOB_ID, seededJob(), { agree: true }, NOW);
    await assertFails(commit(dbFor('owner'), write));
  });

  it('denies malformed ratings', async () => {
    const db = dbFor('owner');
    const ref = doc(db, PATHS.job(JOB_ID));
    const good = { agree: false, verdict: 'apply', at: NOW };
    await assertFails(
      updateDoc(ref, { feedback: { ...good, note: 'x'.repeat(281) }, updatedAt: NOW }),
    );
    await assertFails(updateDoc(ref, { feedback: { ...good, note: '' }, updatedAt: NOW }));
    await assertFails(updateDoc(ref, { feedback: { ...good, expected: 'apply' }, updatedAt: NOW }));
    await assertFails(
      updateDoc(ref, { feedback: { ...good, agree: true, expected: 'skip' }, updatedAt: NOW }),
    );
    await assertFails(updateDoc(ref, { feedback: { ...good, extra: 1 }, updatedAt: NOW }));
    await assertFails(updateDoc(ref, { feedback: { ...good, at: CREATED }, updatedAt: NOW }));
    await assertFails(updateDoc(ref, { feedback: { ...good, agree: 'yes' }, updatedAt: NOW }));
    await assertFails(updateDoc(ref, { feedback: 'good', updatedAt: NOW }));
  });

  it('denies a feedback event that disagrees with the job', async () => {
    const write = buildJobFeedbackWrite(JOB_ID, seededJob(), { agree: true }, NOW);
    await assertFails(
      commit(dbFor('owner'), { ...write, event: { ...write.event, agree: false } }),
    );
  });
});

describe('everything else stays server-written', () => {
  beforeEach(async () => {
    await seed();
  });

  it('denies changing funnel and ingest fields, alone or with a valid action', async () => {
    const db = dbFor('owner');
    const ref = doc(db, PATHS.job(JOB_ID));
    for (const patch of [
      { verdict: 'skip' },
      { fitScore: 10 },
      { title: 'CEO' },
      { stage: 's0' },
      { next: 's3' },
      { url: 'https://jobs.example.com/other' },
      { flags: [] },
    ]) {
      await assertFails(updateDoc(ref, { ...patch, updatedAt: NOW }));
      await assertFails(updateDoc(ref, { ...patch, status: 'saved', updatedAt: NOW }));
    }
  });

  it('denies creating and deleting jobs, and writing their description', async () => {
    const db = dbFor('owner');
    await assertFails(setDoc(doc(db, PATHS.job('job-2')), seededJob()));
    await assertFails(deleteDoc(doc(db, PATHS.job(JOB_ID))));
    await assertFails(setDoc(doc(db, PATHS.jobDescription(JOB_ID)), { text: 'x' }));
  });

  it('denies an update that changes nothing the owner may change', async () => {
    await assertFails(updateDoc(doc(dbFor('owner'), PATHS.job(JOB_ID)), { updatedAt: NOW }));
  });

  it('denies everyone but the owner', async () => {
    const write = buildJobStatusWrite(JOB_ID, seededJob(), 'saved', NOW);
    await assertFails(commit(dbFor('stranger'), write));
    await assertFails(commit(dbFor('anon'), write));
  });
});

describe('events are create-only', () => {
  beforeEach(async () => {
    await seed();
  });

  it('denies updating or deleting an event, even the owner’s own', async () => {
    const db = dbFor('owner');
    await assertSucceeds(commit(db, buildJobStatusWrite(JOB_ID, seededJob(), 'saved', NOW)));
    const ref = doc(db, `events/${EVENT_ID}`);
    await assertSucceeds(getDoc(ref));
    await assertFails(updateDoc(ref, { to: 'applied' }));
    await assertFails(deleteDoc(ref));
    await assertFails(setDoc(ref, { type: 'job_status' }));
  });

  it('denies an event on its own, or of an unknown shape', async () => {
    const db = dbFor('owner');
    const write = buildJobStatusWrite(JOB_ID, seededJob(), 'saved', NOW);
    // No job change in the batch: the job is still `new`, not `saved`.
    await assertFails(setDoc(doc(db, `events/${EVENT_ID}`), write.event));
    await assertFails(commit(db, { ...write, event: { ...write.event, extra: 1 } }));
    await assertFails(commit(db, { ...write, event: { ...write.event, type: 'other' } }));
    await assertFails(commit(db, { ...write, event: { ...write.event, at: CREATED } }));
    await assertFails(commit(db, { ...write, event: { ...write.event, schemaVersion: 2 } }));
    await assertFails(commit(db, { ...write, event: { ...write.event, jobId: 'missing' } }));
  });

  it('denies everyone but the owner', async () => {
    const write = buildJobStatusWrite(JOB_ID, seededJob(), 'saved', NOW);
    await assertFails(setDoc(doc(dbFor('stranger'), `events/${EVENT_ID}`), write.event));
    await assertFails(setDoc(doc(dbFor('anon'), `events/${EVENT_ID}`), write.event));
  });
});
