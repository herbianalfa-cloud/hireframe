import {
  COLLECTIONS,
  DEFAULT_MONTHLY_CAP_PENCE,
  DOCS,
  JobSchema,
  londonDayStart,
  londonWeekStart,
  monthKey,
  PATHS,
  spendMeter,
  UsageSchema,
  verdictAgreement,
  AGREEMENT_DAYS,
  type Agreement,
  type SpendMeter,
  type TodayCountResults,
  type TodayCounts,
  type Verdict,
} from '@hireframe/shared';
import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  Timestamp,
  type Firestore,
  type Query,
  type QueryConstraint,
} from 'firebase/firestore';

import { getFirebase } from './firebase';
import { addedByYouSpec, parseJobs, type JobView } from './jobs';
import { errorCode, logError } from './log';
import { listen, type LiveState, type Unsubscribe } from './profile';
import { specConstraints, type QuerySpec } from './query-spec';
import { isTransient, withRetry, withTimeout } from './resilience';
import { timestampsToDates } from './timestamps';

/**
 * Dashboard services (PRD R7, R11; ADR-038): the Today lists, the tile counts, the month's spend
 * and verdict agreement. Lists and spend are live; counts and agreement are one-shot reads that
 * the screen repeats after an action.
 */

export type { TodayCountResults };

export const TODAY_LIST_SIZE = 10;
/** Jobs the Added by you section shows (ADR-049). */
export const ADDED_BY_YOU_SIZE = 5;
const READ_TIMEOUT_MS = 15_000;
/** Most rows read for agreement: a fortnight of one person's feedback is far below this. */
const AGREEMENT_READ_LIMIT = 500;

/** The three Today lists. Open means still waiting for a decision. */
export const TODAY_LISTS = ['apply', 'near_miss', 'wildcard'] as const satisfies readonly Verdict[];
export type TodayListId = (typeof TODAY_LISTS)[number];

const OPEN_STATUSES = ['new', 'saved'];

const jobs = (db: Firestore) => collection(db, COLLECTIONS.jobs);
const run = (db: Firestore, spec: QuerySpec, ...extra: QueryConstraint[]): Query =>
  query(jobs(db), ...specConstraints(spec), ...extra);

const JUDGED_VERDICTS: readonly Verdict[] = ['apply', 'near_miss', 'wildcard'];

/** Open means still waiting for a decision. */
function openSpec(verdicts: readonly Verdict[]): QuerySpec {
  return {
    collection: COLLECTIONS.jobs,
    filters: [
      verdicts.length === 1
        ? { field: 'verdict', op: '==', value: verdicts[0] }
        : { field: 'verdict', op: 'in', value: verdicts },
      { field: 'status', op: 'in', value: OPEN_STATUSES },
    ],
    orderBy: [],
  };
}

/** A Today list: open jobs of one verdict, newest judged first. */
export function todayListSpec(list: TodayListId): QuerySpec {
  return { ...openSpec([list]), orderBy: [{ field: 'judgedAt', direction: 'desc' }] };
}

/**
 * The tile counts. The two range counts carry an explicit descending order so the existing
 * descending indexes serve them; unordered, a range query scans ascending and needs its own.
 */
export function kpiSpecs(now: Date) {
  const dayStart = Timestamp.fromDate(londonDayStart(now));
  const weekStart = Timestamp.fromDate(londonWeekStart(now));
  return {
    toApply: openSpec(['apply']),
    toReview: openSpec(['near_miss', 'wildcard']),
    judgedToday: {
      collection: COLLECTIONS.jobs,
      filters: [
        { field: 'verdict', op: 'in', value: JUDGED_VERDICTS },
        { field: 'judgedAt', op: '>=', value: dayStart },
      ],
      orderBy: [{ field: 'judgedAt', direction: 'desc' }],
    },
    appliedThisWeek: {
      collection: COLLECTIONS.jobs,
      filters: [
        { field: 'status', op: '==', value: 'applied' },
        { field: 'appliedAt', op: '>=', value: weekStart },
      ],
      orderBy: [{ field: 'appliedAt', direction: 'desc' }],
    },
  } satisfies Record<keyof TodayCounts, QuerySpec>;
}

/** The two agreement reads (ratings, and jobs applied) since `since`. */
export function agreementSpecs(since: Timestamp) {
  return {
    rated: {
      collection: COLLECTIONS.jobs,
      filters: [
        { field: 'feedback.agree', op: 'in', value: [true, false] },
        { field: 'feedback.at', op: '>=', value: since },
      ],
      orderBy: [{ field: 'feedback.at', direction: 'desc' }],
    },
    applied: {
      collection: COLLECTIONS.jobs,
      filters: [
        { field: 'status', op: '==', value: 'applied' },
        { field: 'appliedAt', op: '>=', value: since },
      ],
      orderBy: [{ field: 'appliedAt', direction: 'desc' }],
    },
  } satisfies Record<string, QuerySpec>;
}

/** Every dashboard query, for the index check. */
export function dashboardQuerySpecs(now: Date): Record<string, QuerySpec> {
  const since = Timestamp.fromMillis(now.getTime());
  return {
    ...Object.fromEntries(TODAY_LISTS.map((list) => [`list:${list}`, todayListSpec(list)])),
    'list:added-by-you': addedByYouSpec,
    ...Object.fromEntries(Object.entries(kpiSpecs(now)).map(([k, v]) => [`count:${k}`, v])),
    ...Object.fromEntries(
      Object.entries(agreementSpecs(since)).map(([k, v]) => [`agreement:${k}`, v]),
    ),
  };
}

/** A Today list, newest judged first, live. */
export function watchTodayList(
  list: TodayListId,
  callback: (state: LiveState<JobView[]>) => void,
): Unsubscribe {
  callback({ status: 'loading' });
  return listen(
    async () => {
      const { db } = await getFirebase();
      return onSnapshot(
        run(db, todayListSpec(list), limit(TODAY_LIST_SIZE)),
        (snapshot) => {
          const { jobs: views, invalid } = parseJobs(snapshot.docs);
          callback({ status: 'ready', data: views, invalid });
        },
        (error) => {
          logError('dashboard.list_failed', { list, code: error.code });
          callback({ status: 'error', message: "Couldn't load this list. Reload to try again." });
        },
      );
    },
    (message) => {
      callback({ status: 'error', message });
    },
  );
}

/**
 * The newest jobs added from Lookup, live, with their state. A separate query that Today starts
 * only after `hf:usable`, so it never delays it.
 */
export function watchAddedByYou(callback: (state: LiveState<JobView[]>) => void): Unsubscribe {
  callback({ status: 'loading' });
  return listen(
    async () => {
      const { db } = await getFirebase();
      return onSnapshot(
        run(db, addedByYouSpec, limit(ADDED_BY_YOU_SIZE)),
        (snapshot) => {
          const { jobs: views, invalid } = parseJobs(snapshot.docs);
          callback({ status: 'ready', data: views, invalid });
        },
        (error) => {
          logError('dashboard.added_failed', { code: error.code });
          callback({ status: 'error', message: "Couldn't load the jobs you added." });
        },
      );
    },
    (message) => {
      callback({ status: 'error', message });
    },
  );
}

async function count(label: string, source: Query): Promise<number> {
  const snapshot = await withRetry(
    () => withTimeout(getCountFromServer(source), READ_TIMEOUT_MS, label),
    { label: `dashboard.${label}`, isRetryable: isTransient },
  );
  return snapshot.data().count;
}

/** The four tile counts, measured at `now` (London day and week). One aggregation read each. */
export async function loadTodayCounts(now: Date): Promise<TodayCountResults> {
  const { db } = await getFirebase();
  const specs = kpiSpecs(now);
  const keys = Object.keys(specs) as (keyof TodayCounts)[];
  const settled = await Promise.allSettled(keys.map((key) => count(key, run(db, specs[key]))));
  const results = {} as TodayCountResults;
  keys.forEach((key, i) => {
    const outcome = settled[i];
    if (outcome?.status === 'fulfilled') {
      results[key] = outcome.value;
    } else {
      results[key] = null;
      logError('dashboard.count_failed', {
        count: key,
        code: errorCode(outcome?.reason) ?? 'unknown',
      });
    }
  });
  return results;
}

export interface SpendView {
  meter: SpendMeter;
  /** True when this month has no usage document yet (nothing spent, default cap shown). */
  untouched: boolean;
}

/**
 * The cap the meter shows: `config/app.monthlyCapPence` (the console override the functions
 * enforce), else the cap stored on this month's usage document, else the default.
 */
export function resolveCapPence(configCap: number | undefined, usageCap: number | undefined) {
  return configCap ?? usageCap ?? DEFAULT_MONTHLY_CAP_PENCE;
}

/** Builds the meter from a usage document's data (null when the month has none yet). */
export function spendViewFrom(usageData: unknown, configCap: number | undefined): SpendView | null {
  if (usageData === null) {
    return {
      meter: spendMeter(0, resolveCapPence(configCap, undefined)),
      untouched: true,
    };
  }
  const parsed = UsageSchema.safeParse(timestampsToDates(usageData));
  if (!parsed.success) return null;
  return {
    meter: spendMeter(parsed.data.spendPence, resolveCapPence(configCap, parsed.data.capPence)),
    untouched: false,
  };
}

/** `config/app.monthlyCapPence`, or undefined when unset or unreadable (the meter then falls back). */
async function readConfiguredCap(db: Firestore): Promise<number | undefined> {
  try {
    const snapshot = await withTimeout(getDoc(doc(db, DOCS.appConfig)), READ_TIMEOUT_MS, 'config');
    const cap: unknown = snapshot.data()?.monthlyCapPence;
    return typeof cap === 'number' && Number.isInteger(cap) && cap >= 0 ? cap : undefined;
  } catch (error) {
    logError('dashboard.config_failed', { code: errorCode(error) ?? 'unknown' });
    return undefined;
  }
}

/** This month's spend against the cap, live (PRD R11). */
export function watchSpend(
  now: Date,
  callback: (state: LiveState<SpendView>) => void,
): Unsubscribe {
  callback({ status: 'loading' });
  return listen(
    async () => {
      const { db } = await getFirebase();
      const configCap = await readConfiguredCap(db);
      return onSnapshot(
        doc(db, PATHS.usage(monthKey(now))),
        (snapshot) => {
          const view = spendViewFrom(snapshot.exists() ? snapshot.data() : null, configCap);
          if (!view) {
            logError('dashboard.usage_invalid', {});
            callback({ status: 'error', message: "This month's spend couldn't be read." });
            return;
          }
          callback({ status: 'ready', data: view, invalid: 0 });
        },
        (error) => {
          logError('dashboard.usage_failed', { code: error.code });
          callback({ status: 'error', message: "Couldn't load this month's spend." });
        },
      );
    },
    (message) => {
      callback({ status: 'error', message });
    },
  );
}

const AgreementJobSchema = JobSchema.pick({
  verdict: true,
  status: true,
  appliedAt: true,
  appliedVerdict: true,
  feedback: true,
});

/** Verdict agreement over the last `days` days (ADR-038), from ratings and applied-on-Apply. */
export async function loadAgreement(now: Date, days = AGREEMENT_DAYS): Promise<Agreement> {
  const { db } = await getFirebase();
  const since = Timestamp.fromMillis(now.getTime() - days * 86_400_000);
  const specs = agreementSpecs(since);
  const [rated, applied] = await Promise.all([
    withRetry(
      () =>
        withTimeout(
          getDocs(run(db, specs.rated, limit(AGREEMENT_READ_LIMIT))),
          READ_TIMEOUT_MS,
          'agreement ratings',
        ),
      { label: 'dashboard.agreement_rated', isRetryable: isTransient },
    ),
    withRetry(
      () =>
        withTimeout(
          getDocs(run(db, specs.applied, limit(AGREEMENT_READ_LIMIT))),
          READ_TIMEOUT_MS,
          'agreement applied',
        ),
      { label: 'dashboard.agreement_applied', isRetryable: isTransient },
    ),
  ]);
  // A job both rated and applied appears in both reads; keep it once.
  const byId = new Map<string, unknown>();
  for (const item of [...rated.docs, ...applied.docs]) {
    byId.set(item.id, timestampsToDates(item.data({ serverTimestamps: 'estimate' })));
  }
  const rows = [...byId.values()].flatMap((data) => {
    const parsed = AgreementJobSchema.safeParse(data);
    return parsed.success ? [parsed.data] : [];
  });
  return verdictAgreement(rows, now, days);
}
