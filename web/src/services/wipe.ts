import {
  COLLECTIONS,
  DeleteAllDataInputSchema,
  DeleteAllDataResultSchema,
  PATHS,
  type DeleteAllDataInput,
  type DeleteAllDataResult,
  type WipeStep,
} from '@hireframe/shared';
import { collection, getCountFromServer } from 'firebase/firestore';

import { callOwnerCallable } from './callable';
import { getFirebase } from './firebase';
import { isTransient, withRetry, withTimeout } from './resilience';

/**
 * Delete all my data (ADR-057). One call is one bounded server pass; `runWipe` repeats it until
 * the server says `done`. The call is never retried here: an error or a refusal stops the loop
 * and the owner decides (the server consumes the App Check token, so a repeat would be refused
 * anyway). Components use these functions, never Firebase directly.
 */

export const WIPE_MAX_CALLS = 20;

export async function deleteAllData(input: DeleteAllDataInput): Promise<DeleteAllDataResult> {
  const parsed = DeleteAllDataInputSchema.parse(input);
  return DeleteAllDataResultSchema.parse(await callOwnerCallable('deleteAllData', parsed));
}

export interface WipeTotals {
  /** Calls made so far, across Continue presses. */
  calls: number;
  documents: number;
  files: number;
  /** Summed over calls: the profile step reports its counts in one call only. */
  profile: { facts: number; documents: number; files: number };
  remaining: WipeStep[];
  done: boolean;
}

export const EMPTY_WIPE_TOTALS: WipeTotals = {
  calls: 0,
  documents: 0,
  files: 0,
  profile: { facts: 0, documents: 0, files: 0 },
  remaining: [],
  done: false,
};

export function addResult(totals: WipeTotals, result: DeleteAllDataResult): WipeTotals {
  return {
    calls: totals.calls + 1,
    documents: totals.documents + result.deleted.documents,
    files: totals.files + result.deleted.files,
    profile: {
      facts: totals.profile.facts + (result.profile?.facts ?? 0),
      documents: totals.profile.documents + (result.profile?.documents ?? 0),
      files: totals.profile.files + (result.profile?.files ?? 0),
    },
    remaining: result.remaining,
    done: result.done,
  };
}

export interface RunWipeOptions {
  /** Totals from an earlier run that stopped at the cap (Continue). */
  from?: WipeTotals;
  maxCalls?: number;
  onProgress?: (totals: WipeTotals) => void;
  call?: (input: DeleteAllDataInput) => Promise<DeleteAllDataResult>;
}

/**
 * Calls `deleteAllData` until `done` or `maxCalls` more calls. Stops at the first error, which
 * propagates (the owner has seen the last progress through `onProgress`). Never retries.
 */
export async function runWipe(
  input: DeleteAllDataInput,
  {
    from = EMPTY_WIPE_TOTALS,
    maxCalls = WIPE_MAX_CALLS,
    onProgress,
    call = deleteAllData,
  }: RunWipeOptions = {},
): Promise<WipeTotals> {
  let totals = from;
  for (let made = 0; made < maxCalls && !totals.done; made += 1) {
    totals = addResult(totals, await call(input));
    onProgress?.(totals);
  }
  return totals;
}

/** What the preview counts, in the order the dialog lists them. */
export const PREVIEW_COUNTS = [
  { key: 'jobs', label: 'jobs', path: COLLECTIONS.jobs },
  { key: 'applications', label: 'applications', path: COLLECTIONS.applications },
  { key: 'cvs', label: 'generated CVs', path: COLLECTIONS.cvs },
  { key: 'runs', label: 'runs', path: COLLECTIONS.runs },
  { key: 'events', label: 'events', path: COLLECTIONS.events },
  { key: 'companies', label: 'companies', path: COLLECTIONS.companies },
  { key: 'sources', label: 'source records', path: COLLECTIONS.sources },
] as const;

/** Counted only for the line about resetting the profile as well. */
export const PROFILE_PREVIEW_COUNTS = [
  { key: 'facts', label: 'facts', path: PATHS.facts },
  { key: 'documents', label: 'uploads', path: PATHS.documents },
] as const;

/**
 * One aggregation read for a collection. Each settles on its own, so one failure shows
 * "unavailable" for that line only.
 */
export async function previewCount(path: string): Promise<number> {
  const { db } = await getFirebase();
  const snapshot = await withRetry(
    () => withTimeout(getCountFromServer(collection(db, path)), 10_000, `count ${path}`),
    { label: 'wipe.count', isRetryable: isTransient },
  );
  return snapshot.data().count;
}
