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
import { DOCS, JobSchema, PATHS } from '@hireframe/shared';
import {
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildJobFeedbackRemovalWrite,
  buildJobFeedbackWrite,
  buildJobStatusWrite,
  type JobActionWrite,
} from '../../web/src/services/job-writes.ts';
import { timestampsToDates } from '../../web/src/services/timestamps.ts';

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

/** The batch the app commits: the job update, its event, and the Applied mirror if the write has one. */
function commit(db: TestFirestore, write: JobActionWrite, eventId = EVENT_ID): Promise<void> {
  const batch = writeBatch(db)
    .update(doc(db, PATHS.job(JOB_ID)), write.update)
    .set(doc(db, `events/${eventId}`), write.event);
  if (write.application) batch.update(doc(db, PATHS.application(JOB_ID)), write.application);
  return batch.commit();
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

async function seedApplication(application: DocumentData): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), PATHS.application(JOB_ID)), application);
  });
}

async function readApplication(): Promise<DocumentData> {
  let data: DocumentData = {};
  await env.withSecurityRulesDisabled(async (ctx) => {
    data = (await getDoc(doc(ctx.firestore(), PATHS.application(JOB_ID)))).data() ?? {};
  });
  return data;
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

describe('the Applied mirror, built by job-writes.ts (M7 7D.4)', () => {
  const APPLIED = { status: 'applied', appliedAt: CREATED, appliedVerdict: 'apply' };

  for (const stage of ['chosen', 'needs_input', 'ready'] as const) {
    it(`marks a ${stage} application applied with the job, and Undo restores it`, async () => {
      await seed();
      await seedApplication(seededApplication({ stage }));
      const owner = dbFor('owner');
      const mark = buildJobStatusWrite(
        JOB_ID,
        seededJob(),
        'applied',
        NOW,
        await readApplication(),
      );
      expect(mark.application).toBeDefined();
      await assertSucceeds(commit(owner, mark));
      expect(await readApplication()).toMatchObject({
        stage: 'applied',
        stageBefore: stage,
        stageAt: CREATED,
      });
      expect((await readJob()).status).toBe('applied');

      const undo = buildJobStatusWrite(
        JOB_ID,
        await readJob(),
        'new',
        NOW,
        await readApplication(),
      );
      await assertSucceeds(commit(owner, undo, 'event-2'));
      const restored = await readApplication();
      expect(restored.stage).toBe(stage);
      expect('stageBefore' in restored).toBe(false);
      expect((await readJob()).status).toBe('new');
    });
  }

  it('undoes to any other status the same way (a skipped job leaves applied too)', async () => {
    await seed(seededJob(APPLIED));
    await seedApplication(seededApplication({ stage: 'applied', stageBefore: 'needs_input' }));
    const write = buildJobStatusWrite(
      JOB_ID,
      seededJob(APPLIED),
      'saved',
      NOW,
      await readApplication(),
    );
    await assertSucceeds(commit(dbFor('owner'), write));
    expect((await readApplication()).stage).toBe('needs_input');
  });

  it('writes nothing to a withdrawn application, and the job change still goes through', async () => {
    await seed();
    await seedApplication(seededApplication({ stage: 'withdrawn' }));
    const write = buildJobStatusWrite(JOB_ID, seededJob(), 'applied', NOW, await readApplication());
    expect(write.application).toBeUndefined();
    await assertSucceeds(commit(dbFor('owner'), write));
    expect((await readApplication()).stage).toBe('withdrawn');
  });

  it('refuses to build Mark applied while the CV is generating, and the rules refuse the same batch', async () => {
    await seed();
    await seedApplication(seededApplication({ stage: 'generating' }));
    const application = await readApplication();
    expect(() => buildJobStatusWrite(JOB_ID, seededJob(), 'applied', NOW, application)).toThrow(
      'still being written',
    );
    const jobOnly = buildJobStatusWrite(JOB_ID, seededJob(), 'applied', NOW);
    await assertFails(
      commit(dbFor('owner'), {
        ...jobOnly,
        application: { stage: 'applied', stageBefore: 'generating', updatedAt: NOW },
      }),
    );
  });

  it('denies the mirror without the job change', async () => {
    await seed();
    await seedApplication(seededApplication());
    const mirror = buildJobStatusWrite(
      JOB_ID,
      seededJob(),
      'applied',
      NOW,
      await readApplication(),
    ).application;
    await assertFails(updateDoc(doc(dbFor('owner'), PATHS.application(JOB_ID)), mirror ?? {}));
  });

  it('denies everyone but the owner', async () => {
    await seed();
    await seedApplication(seededApplication());
    const write = buildJobStatusWrite(JOB_ID, seededJob(), 'applied', NOW, await readApplication());
    await assertFails(commit(dbFor('stranger'), write));
    await assertFails(commit(dbFor('anon'), write));
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
    await assertFails(updateDoc(ref, { feedback: { ...good, note: '   ' }, updatedAt: NOW }));
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

describe('removing a rating (un-rate)', () => {
  const rating = { agree: false, verdict: 'apply', expected: 'near_miss', at: CREATED };
  const rated = (): DocumentData => seededJob({ feedback: rating });
  const ref = () => doc(dbFor('owner'), PATHS.job(JOB_ID));

  beforeEach(async () => {
    await seed(rated());
  });

  it('lets the owner remove the whole rating, recording what was removed', async () => {
    const write = buildJobFeedbackRemovalWrite(JOB_ID, rated(), NOW);
    await assertSucceeds(commit(dbFor('owner'), write));
    const job = await readJob();
    expect('feedback' in job).toBe(false);
    expect(job.verdict).toBe('apply');
    await env.withSecurityRulesDisabled(async (ctx) => {
      const event = (await getDoc(doc(ctx.firestore(), `events/${EVENT_ID}`))).data();
      expect(event).toMatchObject({
        type: 'job_feedback_removed',
        jobId: JOB_ID,
        agree: false,
        verdict: 'apply',
      });
    });
  });

  it('works for a 👍 and on a saved or applied job, and the job can be rated again', async () => {
    for (const status of ['new', 'saved', 'applied'] as const) {
      const raw = seededJob({
        status,
        feedback: { agree: true, verdict: 'apply', at: CREATED },
        ...(status === 'applied' ? { appliedAt: CREATED, appliedVerdict: 'apply' } : {}),
      });
      await seed(raw);
      await assertSucceeds(commit(dbFor('owner'), buildJobFeedbackRemovalWrite(JOB_ID, raw, NOW)));
      const after = await readJob();
      await assertSucceeds(
        commit(
          dbFor('owner'),
          buildJobFeedbackWrite(JOB_ID, after, { agree: false }, NOW),
          'event-2',
        ),
      );
    }
  });

  it('still lets the owner remove a rating made on a verdict a re-score has since changed', async () => {
    const raw = seededJob({ verdict: 'near_miss', feedback: rating });
    await seed(raw);
    await assertSucceeds(commit(dbFor('owner'), buildJobFeedbackRemovalWrite(JOB_ID, raw, NOW)));
  });

  it('denies removing a rating that is not there', async () => {
    await seed();
    await assertFails(updateDoc(ref(), { feedback: deleteField(), updatedAt: NOW }));
  });

  it('denies removing without the server time, or with anything else in the same write', async () => {
    await assertFails(updateDoc(ref(), { feedback: deleteField() }));
    await assertFails(updateDoc(ref(), { feedback: deleteField(), updatedAt: CREATED }));
    await assertFails(
      updateDoc(ref(), { feedback: deleteField(), updatedAt: NOW, status: 'saved' }),
    );
    await assertFails(
      updateDoc(ref(), { feedback: deleteField(), updatedAt: NOW, reason: 'Rewritten.' }),
    );
    await assertFails(
      updateDoc(ref(), { feedback: deleteField(), updatedAt: NOW, verdict: 'skip' }),
    );
    await assertFails(
      updateDoc(ref(), { feedback: deleteField(), updatedAt: NOW, appliedAt: NOW }),
    );
  });

  it('denies removing a part of the rating, or replacing it with something that is not one', async () => {
    await assertFails(updateDoc(ref(), { 'feedback.expected': deleteField(), updatedAt: NOW }));
    await assertFails(updateDoc(ref(), { 'feedback.verdict': deleteField(), updatedAt: NOW }));
    await assertFails(updateDoc(ref(), { feedback: null, updatedAt: NOW }));
    await assertFails(updateDoc(ref(), { feedback: {}, updatedAt: NOW }));
  });

  it('denies a removal event that misstates the rating it removes', async () => {
    const write = buildJobFeedbackRemovalWrite(JOB_ID, rated(), NOW);
    const owner = dbFor('owner');
    await assertFails(commit(owner, { ...write, event: { ...write.event, agree: true } }));
    await assertFails(commit(owner, { ...write, event: { ...write.event, verdict: 'skip' } }));
    await assertFails(commit(owner, { ...write, event: { ...write.event, extra: 1 } }));
    await assertFails(commit(owner, { ...write, event: withoutKeys(write.event, ['verdict']) }));
    await assertFails(commit(owner, { ...write, event: withoutKeys(write.event, ['agree']) }));
    await assertFails(
      commit(owner, { ...write, event: { ...write.event, expected: 'near_miss' } }),
    );
    await assertFails(commit(owner, { ...write, event: { ...write.event, at: CREATED } }));
    await assertFails(commit(owner, { ...write, event: { ...write.event, jobId: 'missing' } }));
  });

  it('denies a removal event with no removal, or riding on another change', async () => {
    const owner = dbFor('owner');
    const write = buildJobFeedbackRemovalWrite(JOB_ID, rated(), NOW);
    // Alone: the rating is still on the job.
    await assertFails(setDoc(doc(owner, `events/${EVENT_ID}`), write.event));
    // With an unrelated valid status change: the rating is still there afterwards.
    const status = buildJobStatusWrite(JOB_ID, rated(), 'saved', NOW);
    await assertFails(
      writeBatch(owner)
        .update(doc(owner, PATHS.job(JOB_ID)), status.update)
        .set(doc(owner, `events/${EVENT_ID}`), write.event)
        .commit(),
    );
    // With a new rating instead of a removal.
    const replace = buildJobFeedbackWrite(JOB_ID, rated(), { agree: true }, NOW);
    await assertFails(
      writeBatch(owner)
        .update(doc(owner, PATHS.job(JOB_ID)), replace.update)
        .set(doc(owner, `events/${EVENT_ID}`), write.event)
        .commit(),
    );
  });

  it('denies a removal event on a job that had no rating', async () => {
    await seed();
    const owner = dbFor('owner');
    const event = buildJobFeedbackRemovalWrite(JOB_ID, rated(), NOW).event;
    await assertFails(
      writeBatch(owner)
        .update(doc(owner, PATHS.job(JOB_ID)), { updatedAt: NOW, status: 'saved' })
        .set(doc(owner, `events/${EVENT_ID}`), event)
        .commit(),
    );
  });

  it('denies everyone but the owner', async () => {
    const write = buildJobFeedbackRemovalWrite(JOB_ID, rated(), NOW);
    await assertFails(commit(dbFor('stranger'), write));
    await assertFails(commit(dbFor('anon'), write));
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

describe('every legitimate batched write from job-writes.ts passes', () => {
  const CLIENT = ['new', 'saved', 'applied', 'skipped'] as const;
  const feedbackInputs = [
    { agree: true },
    { agree: true, note: 'Spot on.' },
    { agree: false },
    { agree: false, note: 'Too senior.', expected: 'near_miss' as const },
    { agree: false, expected: 'skip' as const },
  ];

  for (const judged of [true, false]) {
    it(`covers all status moves on a ${judged ? 'judged' : 'unjudged'} job`, async () => {
      for (const from of CLIENT) {
        for (const to of CLIENT) {
          if (from === to) continue;
          const base = judged ? seededJob() : withoutKeys(seededJob(), ['verdict']);
          const raw = {
            ...base,
            status: from,
            ...(from === 'applied'
              ? { appliedAt: CREATED, ...(judged ? { appliedVerdict: 'apply' } : {}) }
              : {}),
          };
          await seed(raw);
          await assertSucceeds(commit(dbFor('owner'), buildJobStatusWrite(JOB_ID, raw, to, NOW)));
        }
      }
    });
  }

  it('covers every rating the dialog can produce', async () => {
    for (const input of feedbackInputs) {
      await seed();
      await assertSucceeds(
        commit(dbFor('owner'), buildJobFeedbackWrite(JOB_ID, seededJob(), input, NOW)),
      );
    }
  });

  it('covers removing a rating of every kind', async () => {
    for (const input of feedbackInputs) {
      const raw = seededJob();
      await seed(raw);
      const rate = buildJobFeedbackWrite(JOB_ID, raw, input, NOW);
      await assertSucceeds(commit(dbFor('owner'), rate));
      await assertSucceeds(
        commit(
          dbFor('owner'),
          buildJobFeedbackRemovalWrite(JOB_ID, await readJob(), NOW),
          'event-2',
        ),
      );
    }
  });

  it('covers a rating on a job that is saved or applied', async () => {
    for (const status of ['saved', 'applied'] as const) {
      const raw = seededJob({
        status,
        ...(status === 'applied' ? { appliedAt: CREATED, appliedVerdict: 'apply' } : {}),
      });
      await seed(raw);
      await assertSucceeds(
        commit(dbFor('owner'), buildJobFeedbackWrite(JOB_ID, raw, { agree: true }, NOW)),
      );
    }
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

  it('denies a client-created application_stage event: the server writes those (M7)', async () => {
    const db = dbFor('owner');
    const stage = {
      type: 'application_stage',
      jobId: JOB_ID,
      from: null,
      to: 'chosen',
      at: NOW,
      schemaVersion: 1,
    };
    await assertFails(setDoc(doc(db, `events/${EVENT_ID}`), stage));
    // Not even beside a valid job change.
    const write = buildJobStatusWrite(JOB_ID, seededJob(), 'saved', NOW);
    await assertFails(commit(db, { ...write, event: stage }));
  });

  it('denies an event for a change that did not happen (ADR-038)', async () => {
    const db = dbFor('owner');
    // from == to, with the job already there: nothing changed.
    await seed(seededJob({ status: 'saved' }));
    const noop = { ...buildJobStatusWrite(JOB_ID, seededJob(), 'saved', NOW).event, from: 'saved' };
    await assertFails(setDoc(doc(db, `events/${EVENT_ID}`), noop));
    // A rating event that matches an old rating, with no new rating in the batch.
    const rated = seededJob({
      feedback: { agree: true, verdict: 'apply', at: CREATED },
    });
    await seed(rated);
    const old = buildJobFeedbackWrite(JOB_ID, seededJob(), { agree: true }, NOW).event;
    await assertFails(setDoc(doc(db, `events/${EVENT_ID}`), old));
    // The same, riding on an unrelated valid status change.
    const status = buildJobStatusWrite(JOB_ID, rated, 'saved', NOW);
    await assertFails(
      writeBatch(db)
        .update(doc(db, PATHS.job(JOB_ID)), status.update)
        .set(doc(db, `events/${EVENT_ID}`), old)
        .commit(),
    );
  });

  it('denies a status event whose verdict is not the job’s, or that invents one', async () => {
    const db = dbFor('owner');
    await seed();
    const write = buildJobStatusWrite(JOB_ID, seededJob(), 'saved', NOW);
    await assertFails(commit(db, { ...write, event: { ...write.event, verdict: 'skip' } }));
    await assertFails(commit(db, { ...write, event: withoutKeys(write.event, ['verdict']) }));
    const raw = withoutKeys(seededJob(), ['verdict']);
    await seed(raw);
    const unjudged = buildJobStatusWrite(JOB_ID, raw, 'saved', NOW);
    await assertFails(commit(db, { ...unjudged, event: { ...unjudged.event, verdict: 'apply' } }));
  });

  it('denies a feedback event that misstates the expected verdict', async () => {
    await seed();
    const write = buildJobFeedbackWrite(
      JOB_ID,
      seededJob(),
      { agree: false, expected: 'near_miss' },
      NOW,
    );
    await assertFails(
      commit(dbFor('owner'), { ...write, event: { ...write.event, expected: 'skip' } }),
    );
    await assertFails(
      commit(dbFor('owner'), { ...write, event: withoutKeys(write.event, ['expected']) }),
    );
  });

  it('denies everyone but the owner', async () => {
    const write = buildJobStatusWrite(JOB_ID, seededJob(), 'saved', NOW);
    await assertFails(setDoc(doc(dbFor('stranger'), `events/${EVENT_ID}`), write.event));
    await assertFails(setDoc(doc(dbFor('anon'), `events/${EVENT_ID}`), write.event));
  });
});

describe('a job being written (diagnosis)', () => {
  it('shows its own pending write with null server timestamps unless they are estimated', async () => {
    await seed();
    const db = dbFor('owner');
    const ref = doc(db, PATHS.job(JOB_ID));
    const write = buildJobStatusWrite(JOB_ID, seededJob(), 'applied', serverTimestamp());
    const seen: { pending: boolean; plain: DocumentData; estimated: DocumentData }[] = [];
    const stop = onSnapshot(ref, (snapshot) => {
      seen.push({
        pending: snapshot.metadata.hasPendingWrites,
        plain: snapshot.data() ?? {},
        estimated: snapshot.data({ serverTimestamps: 'estimate' }) ?? {},
      });
    });
    await waitFor(() => seen.length > 0);
    const committed = commit(db, write);
    await waitFor(() => seen.some((item) => item.pending));
    await assertSucceeds(committed);
    stop();
    const local = seen.find((item) => item.pending);
    expect(local?.plain.updatedAt).toBeNull();
    expect(local?.plain.appliedAt).toBeNull();
    expect(JobSchema.safeParse(timestampsToDates(local?.plain)).success).toBe(false);
    expect(JobSchema.safeParse(timestampsToDates(local?.estimated)).success).toBe(true);
  });
});

async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!done()) throw new Error('timed out');
}
