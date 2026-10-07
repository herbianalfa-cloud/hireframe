import {
  clientTimeoutMs,
  COLLECTIONS,
  CompanySchema,
  RunSchema,
  SCAN_SOURCE_IDS,
  ScanNowResultSchema,
  SourceHealthSchema,
  type Company,
  type Run,
  type ScanNowResult,
  type ScanSourceId,
  type SourceHealth,
} from '@hireframe/shared';
import {
  collection,
  doc,
  getCountFromServer,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

import { getFirebase, getFunctionsClient } from './firebase';
import { errorCode, logError } from './log';
import { listen, type LiveState, type Unsubscribe } from './profile';
import { specConstraints, type QuerySpec } from './query-spec';
import { isTransient, withRetry, withTimeout } from './resilience';
import { timestampsToDates } from './timestamps';

/**
 * System screen services (PRD R4, R12; ADR-029): source health, recent runs, broken boards,
 * the job count and the `scanNow` callable. Reads are zod-parsed live listeners. `scanNow` is
 * never retried automatically: the server lock and cooldown make a retry safe, but a retry
 * should be the owner's choice.
 */

export interface SourceView {
  id: ScanSourceId;
  health: SourceHealth;
}

export interface RunView {
  id: string;
  run: Run;
}

export interface BoardView {
  id: string;
  company: Company;
}

const isScanSource = (id: string): id is ScanSourceId =>
  (SCAN_SOURCE_IDS as readonly string[]).includes(id);

/** The Gmail bridge's health doc (M6); it has its own card, so the scan sources skip it. */
const EMAIL_SOURCE = 'email';

export function watchSources(callback: (state: LiveState<SourceView[]>) => void): Unsubscribe {
  callback({ status: 'loading' });
  return listen(
    async () => {
      const { db } = await getFirebase();
      return onSnapshot(
        collection(db, COLLECTIONS.sources),
        (snapshot) => {
          const sources: SourceView[] = [];
          let invalid = 0;
          for (const item of snapshot.docs) {
            const parsed = SourceHealthSchema.safeParse(timestampsToDates(item.data()));
            if (item.id === EMAIL_SOURCE) continue;
            if (parsed.success && isScanSource(item.id)) {
              sources.push({ id: item.id, health: parsed.data });
            } else invalid++;
          }
          sources.sort((a, b) => SCAN_SOURCE_IDS.indexOf(a.id) - SCAN_SOURCE_IDS.indexOf(b.id));
          callback({ status: 'ready', data: sources, invalid });
        },
        (error) => {
          logError('system.sources_failed', { code: error.code });
          callback({
            status: 'error',
            message: "Couldn't load source health. Reload to try again.",
          });
        },
      );
    },
    (message) => {
      callback({ status: 'error', message });
    },
  );
}

export function watchRecentRuns(callback: (state: LiveState<RunView[]>) => void): Unsubscribe {
  callback({ status: 'loading' });
  return listen(
    async () => {
      const { db } = await getFirebase();
      return onSnapshot(
        query(collection(db, COLLECTIONS.runs), orderBy('startedAt', 'desc'), limit(5)),
        (snapshot) => {
          const runs: RunView[] = [];
          let invalid = 0;
          for (const item of snapshot.docs) {
            const parsed = RunSchema.safeParse(timestampsToDates(item.data()));
            if (parsed.success) runs.push({ id: item.id, run: parsed.data });
            else invalid++;
          }
          callback({ status: 'ready', data: runs, invalid });
        },
        (error) => {
          logError('system.runs_failed', { code: error.code });
          callback({ status: 'error', message: "Couldn't load recent runs. Reload to try again." });
        },
      );
    },
    (message) => {
      callback({ status: 'error', message });
    },
  );
}

/** Watched companies whose board has been missing for several runs in a row. */
export function watchBrokenBoards(callback: (state: LiveState<BoardView[]>) => void): Unsubscribe {
  callback({ status: 'loading' });
  return listen(
    async () => {
      const { db } = await getFirebase();
      return onSnapshot(
        query(collection(db, COLLECTIONS.companies), where('lastScan.broken', '==', true)),
        (snapshot) => {
          const boards: BoardView[] = [];
          let invalid = 0;
          for (const item of snapshot.docs) {
            const parsed = CompanySchema.safeParse(timestampsToDates(item.data()));
            if (parsed.success) boards.push({ id: item.id, company: parsed.data });
            else invalid++;
          }
          boards.sort((a, b) => a.company.name.localeCompare(b.company.name));
          callback({ status: 'ready', data: boards, invalid });
        },
        (error) => {
          logError('system.boards_failed', { code: error.code });
          callback({ status: 'error', message: "Couldn't load board status." });
        },
      );
    },
    (message) => {
      callback({ status: 'error', message });
    },
  );
}

/** `sources/email`: the Gmail bridge's health, or null before the first ingest (ADR-047). */
export function watchEmailHealth(
  callback: (state: LiveState<SourceHealth | null>) => void,
): Unsubscribe {
  callback({ status: 'loading' });
  return listen(
    async () => {
      const { db } = await getFirebase();
      return onSnapshot(
        doc(db, COLLECTIONS.sources, EMAIL_SOURCE),
        (snapshot) => {
          if (!snapshot.exists()) {
            callback({ status: 'ready', data: null, invalid: 0 });
            return;
          }
          const parsed = SourceHealthSchema.safeParse(timestampsToDates(snapshot.data()));
          callback(
            parsed.success
              ? { status: 'ready', data: parsed.data, invalid: 0 }
              : { status: 'error', message: "Couldn't read the Gmail alerts status." },
          );
        },
        (error) => {
          logError('system.email_failed', { code: error.code });
          callback({ status: 'error', message: "Couldn't load the Gmail alerts status." });
        },
      );
    },
    (message) => {
      callback({ status: 'error', message });
    },
  );
}

/** Jobs S3 sent to wait for a description: alert jobs have none (ADR-048). */
export const needsDescriptionCountSpec: QuerySpec = {
  collection: COLLECTIONS.jobs,
  filters: [{ field: 'next', op: '==', value: 'description' }],
  orderBy: [],
};

export async function countWaitingForDescription(): Promise<number> {
  const { db } = await getFirebase();
  const snapshot = await withRetry(
    () =>
      withTimeout(
        getCountFromServer(
          query(collection(db, COLLECTIONS.jobs), ...specConstraints(needsDescriptionCountSpec)),
        ),
        10_000,
        'waiting for description',
      ),
    { label: 'system.count_waiting', isRetryable: isTransient },
  );
  return snapshot.data().count;
}

/** How many jobs are stored (one aggregation read per 1,000 jobs). */
export async function countJobs(): Promise<number> {
  const { db } = await getFirebase();
  const snapshot = await withRetry(
    () => withTimeout(getCountFromServer(collection(db, COLLECTIONS.jobs)), 10_000, 'job count'),
    { label: 'system.count_jobs', isRetryable: isTransient },
  );
  return snapshot.data().count;
}

export async function scanNow(): Promise<ScanNowResult> {
  const functions = await getFunctionsClient();
  const call = httpsCallable(functions, 'scanNow', {
    timeout: clientTimeoutMs('scanNow'),
    limitedUseAppCheckTokens: true,
  });
  const result = await call({});
  return ScanNowResultSchema.parse(result.data);
}

/** A user-facing message for a failed scan (HttpsError messages are written for users). */
export function scanErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code === 'functions/deadline-exceeded') {
    return 'The scan is taking longer than usual. Recent runs below shows how it ends.';
  }
  if (code?.startsWith('functions/') && code !== 'functions/internal' && error instanceof Error) {
    return error.message;
  }
  return "The scan couldn't start. Try again.";
}
