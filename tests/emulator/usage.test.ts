/**
 * `usage/{yyyy-mm}` transactions against the Firestore emulator (ADR-016). Run with
 * `npm run test:rules`, which starts the emulators. Proves that concurrent reservations can't
 * overshoot the cap together, that stale reservations are ignored, and that settling prunes them.
 */
import { PATHS } from '@hireframe/shared';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SpendCapExceededError } from '../../functions/src/llm/errors.js';
import { firestoreUsageStore, type UsageStore } from '../../functions/src/llm/usage-store.js';

const MONTH = '2026-10';
const NOW = new Date('2026-10-15T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

let app: App;
let db: Firestore;
let store: UsageStore;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run with `npm run test:rules`.');
  app = initializeApp({ projectId: 'demo-hireframe' }, 'usage-test');
  db = getFirestore(app);
  store = firestoreUsageStore(db);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection('usage'));
});

const settled = (id: string, costPence: number) => ({
  month: MONTH,
  id,
  now: NOW,
  model: 'claude-haiku-4-5',
  purpose: 'addFact',
  tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
  costPence,
});

describe('usage store on the emulator', () => {
  it('lets only one of two concurrent reservations through when both do not fit', async () => {
    const results = await Promise.allSettled(
      ['a', 'b'].map((id) =>
        store.reserve({ month: MONTH, id, pence: 60, capPence: 100, now: NOW }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(SpendCapExceededError);
    const doc = (await db.doc(PATHS.usage(MONTH)).get()).data();
    expect(Object.keys(doc?.reservations as object)).toHaveLength(1);
  });

  it('ignores stale reservations in the cap check and prunes them on settle', async () => {
    await db.doc(PATHS.usage(MONTH)).set({
      spendPence: 0,
      capPence: 100,
      reservations: { crashed: { pence: 90, at: minutesAgo(20) } },
      calls: {},
      tokens: {},
      byPurpose: {},
      createdAt: minutesAgo(30),
      updatedAt: minutesAgo(20),
      schemaVersion: 1,
    });
    await store.reserve({ month: MONTH, id: 'live', pence: 60, capPence: 100, now: NOW });
    await store.settle(settled('live', 12.5));
    const doc = (await db.doc(PATHS.usage(MONTH)).get()).data();
    expect(doc).toMatchObject({
      spendPence: 12.5,
      reservations: {},
      calls: { 'claude-haiku-4-5': 1 },
      byPurpose: { addFact: 12.5 },
    });
  });

  it('refuses to spend when the usage document is corrupt (fails closed)', async () => {
    await db.doc(PATHS.usage(MONTH)).set({ spendPence: 'lots' });
    await expect(
      store.reserve({ month: MONTH, id: 'x', pence: 1, capPence: 100, now: NOW }),
    ).rejects.toThrow();
  });
});
