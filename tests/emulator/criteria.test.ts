/**
 * getCurrentCriteria against the Firestore emulator (ADR-019). Run with `npm run test:rules`.
 */
import { CRITERIA_SEED_V1, DOCS, PATHS } from '@hireframe/shared';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getCurrentCriteria } from '../../functions/src/criteria.js';

const AT = new Date('2026-10-01T09:00:00Z');

let app: App;
let db: Firestore;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run with `npm run test:rules`.');
  app = initializeApp({ projectId: 'demo-hireframe' }, 'criteria-test');
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection('criteria'));
});

describe('getCurrentCriteria', () => {
  it('returns null before criteria are seeded', async () => {
    await expect(getCurrentCriteria(db)).resolves.toBeNull();
  });

  it('follows the pointer to the current version', async () => {
    for (const version of [1, 2]) {
      await db.doc(PATHS.criteriaVersion(`v${String(version)}`)).set({
        ...CRITERIA_SEED_V1,
        freshness_days: 10 + version,
        version,
        createdAt: AT,
        schemaVersion: 1,
      });
    }
    await db.doc(DOCS.criteriaCurrent).set({ version: 2, updatedAt: AT, schemaVersion: 1 });
    await expect(getCurrentCriteria(db)).resolves.toMatchObject({ version: 2, freshness_days: 12 });
  });

  it('throws on an invalid version instead of returning partial criteria', async () => {
    await db.doc(PATHS.criteriaVersion('v1')).set({ version: 1 });
    await db.doc(DOCS.criteriaCurrent).set({ version: 1, updatedAt: AT, schemaVersion: 1 });
    await expect(getCurrentCriteria(db)).rejects.toThrow();
  });
});
