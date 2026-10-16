import {
  onSnapshot,
  type DocumentReference,
  type DocumentSnapshot,
  type FirestoreError,
  type Query,
  type QuerySnapshot,
  type Unsubscribe,
} from 'firebase/firestore';

import { getReads, listenerReads } from './read-counter';

/**
 * The services' `onSnapshot` and get helpers: the same calls as the SDK's, plus the dev-only read
 * counter (read-counter.ts). Components never see these.
 */

/** A document or collection reference has a path; a composed query has none to show. */
function labelOf(ref: Query | DocumentReference): string {
  return 'path' in ref ? ref.path : 'query';
}

export function watchSnapshot(
  ref: Query,
  next: (snapshot: QuerySnapshot) => void,
  error?: (error: FirestoreError) => void,
): Unsubscribe;
export function watchSnapshot(
  ref: DocumentReference,
  next: (snapshot: DocumentSnapshot) => void,
  error?: (error: FirestoreError) => void,
): Unsubscribe;
export function watchSnapshot(
  ref: Query | DocumentReference,
  next: (snapshot: never) => void,
  error?: (error: FirestoreError) => void,
): Unsubscribe {
  const count = import.meta.env.DEV ? listenerReads(labelOf(ref)) : undefined;
  return onSnapshot(
    ref as Query,
    (snapshot) => {
      count?.(snapshot);
      next(snapshot as never);
    },
    error,
  );
}

/** Passes a `getDoc` / `getDocs` / `getCountFromServer` answer through, counting its reads in dev. */
export async function tally<T>(read: Promise<T>, label: string): Promise<T> {
  const snapshot = await read;
  if (import.meta.env.DEV) getReads(snapshot, label);
  return snapshot;
}
