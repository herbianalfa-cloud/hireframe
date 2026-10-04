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
  todayKpis,
  UsageSchema,
  verdictAgreement,
  AGREEMENT_DAYS,
  type Agreement,
  type SpendMeter,
  type TodayKpis,
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
  orderBy,
  query,
  Timestamp,
  where,
  type Firestore,
  type Query,
} from 'firebase/firestore';

import { getFirebase } from './firebase';
import { parseJobs, type JobView } from './jobs';
import { errorCode, logError } from './log';
import { listen, type LiveState, type Unsubscribe } from './profile';
import { isTransient, withRetry, withTimeout } from './resilience';
import { timestampsToDates } from './timestamps';

/**
 * Dashboard services (PRD R7, R11; ADR-038): the Today lists, the tile counts, the month's spend
 * and verdict agreement. Lists and spend are live; counts and agreement are one-shot reads that
 * the screen repeats after an action.
 */

export const TODAY_LIST_SIZE = 10;
const READ_TIMEOUT_MS = 15_000;
/** Most rows read for agreement: a fortnight of one person's feedback is far below this. */
const AGREEMENT_READ_LIMIT = 500;

/** The three Today lists. Open means still waiting for a decision. */
export const TODAY_LISTS = ['apply', 'near_miss', 'wildcard'] as const satisfies readonly Verdict[];
export type TodayListId = (typeof TODAY_LISTS)[number];

const OPEN_STATUSES = ['new', 'saved'];

const jobs = (db: Firestore) => collection(db, COLLECTIONS.jobs);

function openJobs(db: Firestore, verdicts: readonly Verdict[]): Query {
  return query(
    jobs(db),
    where(
      'verdict',
      verdicts.length === 1 ? '==' : 'in',
      verdicts.length === 1 ? verdicts[0] : verdicts,
    ),
    where('status', 'in', OPEN_STATUSES),
  );
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
        query(openJobs(db, [list]), orderBy('judgedAt', 'desc'), limit(TODAY_LIST_SIZE)),
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

async function count(label: string, source: Query): Promise<number> {
  const snapshot = await withRetry(
    () => withTimeout(getCountFromServer(source), READ_TIMEOUT_MS, label),
    { label: `dashboard.${label}`, isRetryable: isTransient },
  );
  return snapshot.data().count;
}

/** The four tile counts, measured at `now` (London day and week). One aggregation read each. */
export async function loadTodayKpis(now: Date, weeklyTarget: number): Promise<TodayKpis> {
  const { db } = await getFirebase();
  const dayStart = Timestamp.fromDate(londonDayStart(now));
  const weekStart = Timestamp.fromDate(londonWeekStart(now));
  const [toApply, toReview, judgedToday, appliedThisWeek] = await Promise.all([
    count('to_apply', openJobs(db, ['apply'])),
    count('to_review', openJobs(db, ['near_miss', 'wildcard'])),
    count(
      'judged_today',
      query(
        jobs(db),
        where('verdict', 'in', ['apply', 'near_miss', 'wildcard']),
        where('judgedAt', '>=', dayStart),
      ),
    ),
    count(
      'applied_week',
      query(jobs(db), where('status', '==', 'applied'), where('appliedAt', '>=', weekStart)),
    ),
  ]);
  return todayKpis({ toApply, toReview, judgedToday, appliedThisWeek }, weeklyTarget);
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
export function spendViewFrom(
  usageData: unknown,
  configCap: number | undefined,
): SpendView | null {
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
    logError('dashboard.config_failed', { code: errorCode(error) });
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
  const [rated, applied] = await Promise.all([
    withRetry(
      () =>
        withTimeout(
          getDocs(
            query(
              jobs(db),
              where('feedback.agree', 'in', [true, false]),
              where('feedback.at', '>=', since),
              orderBy('feedback.at', 'desc'),
              limit(AGREEMENT_READ_LIMIT),
            ),
          ),
          READ_TIMEOUT_MS,
          'agreement ratings',
        ),
      { label: 'dashboard.agreement_rated', isRetryable: isTransient },
    ),
    withRetry(
      () =>
        withTimeout(
          getDocs(
            query(
              jobs(db),
              where('status', '==', 'applied'),
              where('appliedAt', '>=', since),
              orderBy('appliedAt', 'desc'),
              limit(AGREEMENT_READ_LIMIT),
            ),
          ),
          READ_TIMEOUT_MS,
          'agreement applied',
        ),
      { label: 'dashboard.agreement_applied', isRetryable: isTransient },
    ),
  ]);
  // A job both rated and applied appears in both reads; keep it once.
  const byId = new Map<string, unknown>();
  for (const item of [...rated.docs, ...applied.docs]) {
    byId.set(item.id, timestampsToDates(item.data()));
  }
  const rows = [...byId.values()].flatMap((data) => {
    const parsed = AgreementJobSchema.safeParse(data);
    return parsed.success ? [parsed.data] : [];
  });
  return verdictAgreement(rows, now, days);
}
