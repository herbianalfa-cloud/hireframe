import {
  clientTimeoutMs,
  COLLECTIONS,
  dedupeKey,
  LookupAddResultSchema,
  LookupDescribeResultSchema,
  LookupInputSchema,
  LookupParseResultSchema,
  parseLocation,
  type LookupAddResult,
  type LookupDescribeResult,
  type LookupInput,
  type LookupJobInput,
  type LookupParseResult,
  type LookupRow,
  type LookupTarget,
  type PasteLink,
} from '@hireframe/shared';
import { collection, getDocs, limit, onSnapshot, query, type Firestore } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

import { getFirebase, getFunctionsClient } from './firebase';
import { parseJobs, type JobView } from './jobs';
import { errorCode, logError } from './log';
import { listen, type LiveState, type Unsubscribe } from './profile';
import { specConstraints, type QuerySpec } from './query-spec';
import { isTransient, withRetry, withTimeout } from './resilience';

/**
 * Lookup services (PRD R8, ADR-049). Matching is a plain read of `jobs` (the owner can read
 * them): by source key and by canonical URL, so it works even while a scan runs and spends
 * nothing. The `lookup` callable creates and judges jobs, spends money, and is never retried
 * here. Nothing is fetched from LinkedIn: only text the owner pastes is read.
 */

/** Firestore's limit on `array-contains-any` values. */
export const KEY_CHUNK = 30;
const READ_TIMEOUT_MS = 15_000;
/** URL lookups in flight at once. */
const URL_CONCURRENCY = 8;
/** Waiting-for-description jobs per page. */
export const WAITING_PAGE_SIZE = 20;

const jobsCollection = (db: Firestore) => collection(db, COLLECTIONS.jobs);

// ---- Queries (each is checked against firestore.indexes.json in indexes.test.ts) ----

/** Jobs holding any of up to 30 source keys. The automatic index serves it. */
export function lookupKeysSpec(keys: readonly string[]): QuerySpec {
  return {
    collection: COLLECTIONS.jobs,
    filters: [{ field: 'keys', op: 'array-contains-any', value: keys }],
    orderBy: [],
  };
}

/** The job stored under a canonical URL. The automatic index serves it. */
export function lookupUrlSpec(url: string): QuerySpec {
  return {
    collection: COLLECTIONS.jobs,
    filters: [{ field: 'url', op: '==', value: url }],
    orderBy: [],
  };
}

/** Jobs waiting for a pasted description, newest first. Served by `(next, sortAt desc)`. */
export const needsDescriptionSpec: QuerySpec = {
  collection: COLLECTIONS.jobs,
  filters: [{ field: 'next', op: '==', value: 'description' }],
  orderBy: [{ field: 'sortAt', direction: 'desc' }],
};

// ---- Matching ----

/** The keys a pasted results-page row can be found by: its LinkedIn ID, else company|title|city. */
export function rowKeys(row: LookupRow): string[] {
  const keys: string[] = [];
  if (row.linkedinId) keys.push(`linkedin:${row.linkedinId}`);
  const byName = dedupeKey(row.company, row.title, parseLocation(row.location).city);
  if (byName) keys.push(byName);
  return keys;
}

/** Each key mapped to the job holding it (the first job read wins a shared key). */
export function indexByKey(views: readonly JobView[]): Map<string, JobView> {
  const byKey = new Map<string, JobView>();
  for (const view of views) {
    for (const key of view.job.keys) if (!byKey.has(key)) byKey.set(key, view);
  }
  return byKey;
}

/** The job for the first of `keys` that has one: the most specific key (an ID) comes first. */
export function pickMatch(keys: readonly string[], byKey: ReadonlyMap<string, JobView>) {
  for (const key of keys) {
    const view = byKey.get(key);
    if (view) return view;
  }
  return null;
}

async function readKeys(keys: readonly string[]): Promise<JobView[]> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return [];
  const { db } = await getFirebase();
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += KEY_CHUNK) chunks.push(unique.slice(i, i + KEY_CHUNK));
  const snapshots = await Promise.all(
    chunks.map((chunk) =>
      withRetry(
        () =>
          withTimeout(
            getDocs(query(jobsCollection(db), ...specConstraints(lookupKeysSpec(chunk)))),
            READ_TIMEOUT_MS,
            'lookup keys',
          ),
        { label: 'lookup.keys', isRetryable: isTransient },
      ),
    ),
  );
  return snapshots.flatMap((snapshot) => parseJobs(snapshot.docs).jobs);
}

async function readUrl(url: string): Promise<JobView | null> {
  const { db } = await getFirebase();
  const snapshot = await withRetry(
    () =>
      withTimeout(
        getDocs(query(jobsCollection(db), ...specConstraints(lookupUrlSpec(url)), limit(1))),
        READ_TIMEOUT_MS,
        'lookup url',
      ),
    { label: 'lookup.url', isRetryable: isTransient },
  );
  return parseJobs(snapshot.docs).jobs[0] ?? null;
}

/** Each pasted URL's stored job, or null when it hasn't been seen. Input order is kept. */
export async function matchTargets(targets: readonly LookupTarget[]): Promise<(JobView | null)[]> {
  const byKey = indexByKey(await readKeys(targets.flatMap((target) => target.keys)));
  const found = targets.map((target) => pickMatch(target.keys, byKey));
  // Whatever the keys missed is looked up by its canonical URL.
  const missing = found.flatMap((view, index) => (view ? [] : [index]));
  for (let i = 0; i < missing.length; i += URL_CONCURRENCY) {
    const batch = missing.slice(i, i + URL_CONCURRENCY);
    const views = await Promise.all(
      batch.map((index) => readUrl(targets[index]?.url ?? '').catch(() => null)),
    );
    batch.forEach((index, at) => {
      found[index] = views[at] ?? null;
    });
  }
  return found;
}

/** Each results-page row's stored job, or null when it hasn't been seen. Input order is kept. */
export async function matchRows(rows: readonly LookupRow[]): Promise<(JobView | null)[]> {
  const byKey = indexByKey(await readKeys(rows.flatMap(rowKeys)));
  return rows.map((row) => pickMatch(rowKeys(row), byKey));
}

// ---- Jobs waiting for a description ----

/** Jobs at `next == 'description'` (from Lookup or an email alert), newest first, live. */
export function watchWaitingJobs(
  pageSize: number,
  callback: (state: LiveState<JobView[]>) => void,
): Unsubscribe {
  callback({ status: 'loading' });
  return listen(
    async () => {
      const { db } = await getFirebase();
      return onSnapshot(
        query(jobsCollection(db), ...specConstraints(needsDescriptionSpec), limit(pageSize)),
        (snapshot) => {
          const { jobs, invalid } = parseJobs(snapshot.docs);
          callback({ status: 'ready', data: jobs, invalid });
        },
        (error) => {
          logError('lookup.waiting_failed', { code: error.code });
          callback({
            status: 'error',
            message: "Couldn't load the jobs waiting for a description.",
          });
        },
      );
    },
    (message) => {
      callback({ status: 'error', message });
    },
  );
}

// ---- The callable ----

/**
 * One call to `lookup`. It spends money and is not safe to repeat blindly, so there is no retry:
 * a failure is shown and the owner decides. The input is checked here first, so a paste that is
 * too big fails on this side.
 */
async function callLookup(input: LookupInput): Promise<unknown> {
  const parsed = LookupInputSchema.parse(input);
  const functions = await getFunctionsClient();
  const call = httpsCallable(functions, 'lookup', {
    timeout: clientTimeoutMs('lookup'),
    limitedUseAppCheckTokens: true,
  });
  const result = await call(parsed);
  return result.data;
}

/** Create and judge jobs read from a results page, or fetched from a job board's own API. */
export async function lookupAdd(jobs: readonly LookupJobInput[]): Promise<LookupAddResult> {
  return LookupAddResultSchema.parse(await callLookup({ action: 'add', jobs: [...jobs] }));
}

/** Judge a job waiting for a description from text the owner pasted. */
export async function lookupDescribe(jobId: string, text: string): Promise<LookupDescribeResult> {
  return LookupDescribeResultSchema.parse(await callLookup({ action: 'describe', jobId, text }));
}

/** The one cheap-model read of a results page the deterministic parser couldn't read. */
export async function lookupParse(
  text: string,
  links: readonly PasteLink[],
): Promise<LookupParseResult> {
  return LookupParseResultSchema.parse(
    await callLookup({ action: 'parse', text, links: [...links] }),
  );
}

/** A user-facing message for a failed Lookup call (HttpsError messages are written for users). */
export function lookupErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code === 'functions/deadline-exceeded') {
    return 'Lookup is taking longer than usual. Added by you on Today shows how it ends.';
  }
  if (code?.startsWith('functions/') && code !== 'functions/internal' && error instanceof Error) {
    return error.message;
  }
  return "Lookup couldn't finish. Check your connection and try again.";
}
