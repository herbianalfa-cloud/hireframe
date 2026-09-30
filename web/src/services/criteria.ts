import {
  COLLECTIONS,
  CriteriaPointerSchema,
  CriteriaVersionSchema,
  criteriaVersionId,
  CRITERIA_SEED_V1,
  DOCS,
  PATHS,
  type CriteriaContent,
  type CriteriaVersion,
} from '@hireframe/shared';
import {
  collection,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';

import { buildCriteriaWrite } from './fact-writes';
import { getFirebase } from './firebase';
import { errorCode, logError } from './log';
import { listen, type Unsubscribe } from './profile';
import { withTimeout } from './resilience';
import { timestampsToDates } from './timestamps';

/**
 * Criteria services (PRD R3, ADR-019). `criteria/current` points at an immutable
 * `criteria/v{n}`; saving writes v{n+1} and moves the pointer in one transaction.
 */
export type CriteriaState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; criteria: CriteriaVersion }
  | { status: 'error'; message: string };

const WRITE_TIMEOUT_MS = 15_000;

export class CriteriaConflictError extends Error {
  override name = 'CriteriaConflictError';
}

/** The current criteria version, live. */
export function watchCurrentCriteria(callback: (state: CriteriaState) => void): Unsubscribe {
  callback({ status: 'loading' });
  let versionUnsubscribe: Unsubscribe | undefined;
  const fail = (message: string) => {
    callback({ status: 'error', message });
  };
  const stop = listen(async () => {
    const { db } = await getFirebase();
    return onSnapshot(
      doc(db, DOCS.criteriaCurrent),
      (pointerSnapshot) => {
        versionUnsubscribe?.();
        versionUnsubscribe = undefined;
        if (!pointerSnapshot.exists()) {
          callback({ status: 'empty' });
          return;
        }
        const pointer = CriteriaPointerSchema.safeParse(timestampsToDates(pointerSnapshot.data()));
        if (!pointer.success) {
          fail('The criteria pointer is invalid.');
          return;
        }
        versionUnsubscribe = onSnapshot(
          doc(db, PATHS.criteriaVersion(criteriaVersionId(pointer.data.version))),
          (versionSnapshot) => {
            const parsed = CriteriaVersionSchema.safeParse(
              timestampsToDates(versionSnapshot.data()),
            );
            if (parsed.success) callback({ status: 'ready', criteria: parsed.data });
            else fail(`Criteria v${String(pointer.data.version)} is invalid.`);
          },
          (error) => {
            logError('criteria.version_failed', { code: error.code });
            fail("Couldn't load your criteria. Reload to try again.");
          },
        );
      },
      (error) => {
        logError('criteria.pointer_failed', { code: error.code });
        fail("Couldn't load your criteria. Reload to try again.");
      },
    );
  }, fail);
  return () => {
    versionUnsubscribe?.();
    stop();
  };
}

/** Creates criteria v1 from the FUNNEL.md seed. Fails if criteria already exist. */
export async function seedCriteria(): Promise<void> {
  const { db } = await getFirebase();
  const write = buildCriteriaWrite(CRITERIA_SEED_V1, 1, serverTimestamp());
  const batch = writeBatch(db);
  batch.set(doc(db, PATHS.criteriaVersion(write.versionId)), write.versionDoc);
  batch.set(doc(db, DOCS.criteriaCurrent), write.pointerDoc);
  await withTimeout(batch.commit(), WRITE_TIMEOUT_MS, 'criteria seed');
}

/**
 * Saves `content` as the next version. `basedOn` is the version the form started from; if the
 * pointer has moved since, nothing is written and CriteriaConflictError is thrown.
 */
export async function saveCriteria(content: CriteriaContent, basedOn: number): Promise<number> {
  const { db } = await getFirebase();
  const pointerRef = doc(db, DOCS.criteriaCurrent);
  return withTimeout(
    runTransaction(db, async (tx) => {
      const pointerSnapshot = await tx.get(pointerRef);
      const pointer = CriteriaPointerSchema.parse(timestampsToDates(pointerSnapshot.data()));
      if (pointer.version !== basedOn)
        throw new CriteriaConflictError('Criteria changed elsewhere.');
      const write = buildCriteriaWrite(content, pointer.version + 1, serverTimestamp());
      tx.set(doc(db, PATHS.criteriaVersion(write.versionId)), write.versionDoc);
      tx.set(pointerRef, write.pointerDoc);
      return pointer.version + 1;
    }),
    WRITE_TIMEOUT_MS,
    'criteria save',
  );
}

export interface CriteriaVersionSummary {
  version: number;
  createdAt: Date;
}

/** Every saved version, newest first (for the history list). */
export function watchCriteriaHistory(
  callback: (
    state:
      | { status: 'ready'; versions: CriteriaVersionSummary[] }
      | { status: 'error'; message: string },
  ) => void,
): Unsubscribe {
  return listen(
    async () => {
      const { db } = await getFirebase();
      return onSnapshot(
        collection(db, COLLECTIONS.criteria),
        (snapshot) => {
          const versions: CriteriaVersionSummary[] = [];
          for (const item of snapshot.docs) {
            if (item.id === 'current') continue;
            const parsed = CriteriaVersionSchema.safeParse(timestampsToDates(item.data()));
            if (parsed.success)
              versions.push({ version: parsed.data.version, createdAt: parsed.data.createdAt });
          }
          versions.sort((a, b) => b.version - a.version);
          callback({ status: 'ready', versions });
        },
        (error) => {
          logError('criteria.history_failed', { code: error.code });
          callback({ status: 'error', message: "Couldn't load the criteria history." });
        },
      );
    },
    (message) => {
      callback({ status: 'error', message });
    },
  );
}

export function criteriaErrorMessage(error: unknown): string {
  if (error instanceof CriteriaConflictError) {
    return 'Your criteria changed in another tab. Reload to see the latest version.';
  }
  if (errorCode(error) === 'permission-denied')
    return "That change wasn't allowed. Reload and try again.";
  if (error instanceof Error && error.name === 'ZodError')
    return 'Some values are invalid. Check the highlighted fields.';
  return "Couldn't save. Check your connection and try again.";
}
