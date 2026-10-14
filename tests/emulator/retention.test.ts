/**
 * purgeOldData against the Firestore emulator (ADR-057). Run with `npm run test:rules`. Proves
 * the real transaction: only old skipped jobs with no application lose `description/raw`, they
 * are stamped, every other status and verdict is untouched, the cursor is saved, and a second
 * run purges nothing new.
 */
import { DOCS, PATHS } from '@hireframe/shared';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runRetention } from '../../functions/src/retention/run.js';
import { firestoreRetentionStore } from '../../functions/src/retention/store.js';

const NOW = new Date('2026-10-14T03:30:00Z');
const DAY = 86_400_000;
const OLD = new Timestamp(Math.floor((NOW.getTime() - 70 * DAY) / 1000), 0);
const YOUNG = new Timestamp(Math.floor((NOW.getTime() - 20 * DAY) / 1000), 0);

let app: App;
let db: Firestore;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run with `npm run test:rules`.');
  app = initializeApp({ projectId: 'demo-hireframe' }, 'retention-test');
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

async function addJob(id: string, fields: Record<string, unknown>, withApplication = false) {
  await db.doc(PATHS.job(id)).set({
    title: 'Fake job',
    verdict: 'skip',
    judgedAt: OLD,
    status: 'new',
    descriptionKind: 'full',
    updatedAt: OLD,
    ...fields,
  });
  await db.doc(PATHS.jobDescription(id)).set({ text: 'Fake text' });
  if (withApplication) await db.doc(PATHS.application(id)).set({ stage: 'withdrawn' });
}

const hasDescription = async (id: string) => (await db.doc(PATHS.jobDescription(id)).get()).exists;

beforeEach(async () => {
  await db.recursiveDelete(db.collection('jobs'));
  await db.recursiveDelete(db.collection('applications'));
  await db.doc(DOCS.retentionCursor).delete();
});

describe('purgeOldData (ADR-057)', () => {
  it('purges only the eligible jobs, stamps them and saves the cursor', async () => {
    await addJob('old-new', {});
    await addJob('old-skipped', { status: 'skipped' });
    await addJob('young', { judgedAt: YOUNG });
    await addJob('apply-verdict', { verdict: 'apply' });
    for (const status of ['saved', 'applied', 'interview', 'offer', 'rejected']) {
      await addJob(`status-${status}`, { status });
    }
    await addJob('has-application', { status: 'skipped' }, true);
    await addJob('no-text', { descriptionKind: 'none' });

    const result = await runRetention({ store: firestoreRetentionStore(db), now: () => NOW });
    expect(result).toMatchObject({ purged: 2, skippedApplication: 1, failed: false });

    expect(await hasDescription('old-new')).toBe(false);
    expect(await hasDescription('old-skipped')).toBe(false);
    for (const kept of [
      'young',
      'apply-verdict',
      'status-saved',
      'status-applied',
      'status-interview',
      'status-offer',
      'status-rejected',
      'has-application',
      'no-text',
    ]) {
      expect(await hasDescription(kept), kept).toBe(true);
    }
    const stamped = (await db.doc(PATHS.job('old-new')).get()).data();
    expect((stamped?.descriptionPurgedAt as Timestamp).toDate()).toEqual(NOW);
    expect(stamped?.verdict).toBe('skip');
    expect((await db.doc(PATHS.job('young')).get()).data()?.descriptionPurgedAt).toBeUndefined();

    const cursor = (await db.doc(DOCS.retentionCursor).get()).data();
    expect(cursor?.lastId).toBeTypeOf('string');
    expect((cursor?.lastRunAt as Timestamp).toDate()).toEqual(NOW);
  });

  it('a second run purges nothing new', async () => {
    await addJob('a', {});
    await addJob('b', {});
    const store = firestoreRetentionStore(db);
    expect((await runRetention({ store, now: () => NOW })).purged).toBe(2);
    expect(await runRetention({ store, now: () => NOW })).toMatchObject({ read: 0, purged: 0 });
  });

  it('leaves a job whose application was created since the page read', async () => {
    await addJob('late', { status: 'skipped' });
    const real = firestoreRetentionStore(db);
    const store = {
      ...real,
      async purgeChunk(...args: Parameters<typeof real.purgeChunk>) {
        await db.doc(PATHS.application('late')).set({ stage: 'needs_input' });
        return real.purgeChunk(...args);
      },
    };
    expect(await runRetention({ store, now: () => NOW })).toMatchObject({
      purged: 0,
      skippedApplication: 1,
    });
    expect(await hasDescription('late')).toBe(true);
  });

  it('pages through ties on judgedAt with mixed-case IDs, without a repeat or a gap', async () => {
    const ids = ['Bb', 'aa', 'Aa', 'ab', 'Zz', 'a1', 'B2'];
    for (const id of ids) await addJob(id, {});
    const store = firestoreRetentionStore(db);
    const seen: string[] = [];
    let after: { purgedThrough: Date; lastId: string } | null = null;
    for (let page = 0; page < 10; page += 1) {
      const rows = await store.readPage(NOW, after, 2);
      if (rows.length === 0) break;
      for (const row of rows) seen.push(row.id);
      const last = rows[rows.length - 1];
      if (!last) break;
      after = { purgedThrough: last.judgedAt, lastId: last.id };
    }
    // Document IDs sort by their UTF-8 bytes: capitals before lowercase, digits before letters.
    expect(seen).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('skips a malformed job and a malformed cursor instead of failing', async () => {
    await addJob('fine', {});
    await addJob('malformed', { status: 42, descriptionKind: { not: 'a string' } });
    await db.doc(DOCS.retentionCursor).set({ purgedThrough: 'yesterday', lastId: 7 });
    const result = await runRetention({ store: firestoreRetentionStore(db), now: () => NOW });
    expect(result).toMatchObject({ purged: 1, failed: false });
    expect(await hasDescription('fine')).toBe(false);
    expect(await hasDescription('malformed')).toBe(true);
  });
});
