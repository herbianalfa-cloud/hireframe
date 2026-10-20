import { DOCS } from '@hireframe/shared';
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  type Firestore,
} from 'firebase/firestore';
import type { FirebaseApp } from 'firebase/app';

import type { AppConfigRead } from './access';
import { tally } from './reads';
import { timestampsToDates } from './timestamps';

/**
 * What the boot path needs from Firestore, behind one dynamic import (ADR-066): the `firestore`
 * vendor chunk loads with this module, not with the entry chunk. `firebase.ts` imports it once
 * the Firebase core is ready.
 */

const EMULATOR_HOST = '127.0.0.1';

/** Called once per app, after App Check is initialised (the core does that first). */
export function connectDb(app: FirebaseApp): Firestore {
  const db = getFirestore(app);
  if (import.meta.env.DEV) connectFirestoreEmulator(db, EMULATOR_HOST, 8080);
  return db;
}

/** The owner-check read; console Timestamps are converted to Dates here. */
export async function readAppConfig(db: Firestore): Promise<AppConfigRead> {
  const snapshot = await tally(getDoc(doc(db, DOCS.appConfig)), 'access:getDoc');
  return snapshot.exists()
    ? { exists: true, data: timestampsToDates(snapshot.data()) }
    : { exists: false };
}
