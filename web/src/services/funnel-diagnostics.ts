import {
  buildReport,
  COLLECTIONS,
  CriteriaPointerSchema,
  CriteriaVersionSchema,
  criteriaVersionId,
  DOCS,
  isModelSkip,
  PATHS,
  ProfileSettingsSchema,
  type CriteriaContent,
  type DiagnosticJob,
  type Job,
  type DiagnosticsReport,
  type QueueStage,
  type Verdict,
  type WorkRights,
} from '@hireframe/shared';
import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  query,
  Timestamp,
  type Query,
} from 'firebase/firestore';

import { getFirebase } from './firebase';
import { readJob } from './job-read';
import { errorCode, logError } from './log';
import { specConstraints, type QuerySpec } from './query-spec';
import { isTransient, withRetry, withTimeout } from './resilience';
import { timestampsToDates } from './timestamps';

/**
 * Funnel diagnostics for the System screen (docs/plans/funnel-intake-plan.md, ADR-043). The
 * owner's own signed-in reads (firestore.rules lets the owner read `jobs` and their descriptions, though the panel reads none yet)
 * are counted in the browser by `@hireframe/shared`'s pure `buildReport`; nothing here writes,
 * and the report holds counts only. Read on demand, never live: up to about 1,500 job documents
 * per press, and no descriptions.
 */

/** How far back the S2 skips and the good jobs reach. */
export const DIAGNOSTICS_DAYS = 30;
/** Most jobs read per set. */
export const DIAGNOSTICS_READ_LIMIT = 500;
const READ_TIMEOUT_MS = 20_000;

const GOOD_VERDICTS: readonly Verdict[] = ['apply', 'near_miss', 'wildcard'];

const jobsOf = (spec: Partial<QuerySpec>): QuerySpec => ({
  collection: COLLECTIONS.jobs,
  filters: [],
  orderBy: [],
  ...spec,
});

/** The three job sets the panel reads. */
export function diagnosticsSpecs(now: Date) {
  const since = Timestamp.fromMillis(now.getTime() - DIAGNOSTICS_DAYS * 86_400_000);
  return {
    /** Every S2 skip, which includes freshness expiries; code keeps the model's own. */
    s2Skips: jobsOf({
      filters: [
        { field: 'skip.stage', op: '==', value: 's2' },
        { field: 'judgedAt', op: '>=', value: since },
      ],
      orderBy: [{ field: 'judgedAt', direction: 'desc' }],
    }),
    good: jobsOf({
      filters: [
        { field: 'verdict', op: 'in', value: GOOD_VERDICTS },
        { field: 'judgedAt', op: '>=', value: since },
      ],
      orderBy: [{ field: 'judgedAt', direction: 'desc' }],
    }),
    queuedS3: jobsOf({
      filters: [{ field: 'next', op: '==', value: 's3' }],
      orderBy: [{ field: 'sortAt', direction: 'desc' }],
    }),
  } satisfies Record<string, QuerySpec>;
}

/**
 * Queued jobs per stage with and without `sortAt`: an `orderBy('sortAt')` query skips jobs that
 * lack the field, so the difference is the jobs the stages and the expiry sweep can't see.
 */
export function queuedCountSpecs(stage: QueueStage) {
  const waiting: QuerySpec['filters'] = [{ field: 'next', op: '==', value: stage }];
  return {
    all: jobsOf({ filters: waiting }),
    withSortAt: jobsOf({
      filters: waiting,
      orderBy: [{ field: 'sortAt', direction: 'desc' }],
    }),
  } satisfies Record<string, QuerySpec>;
}

/** Every diagnostics query, for the index check. */
export function diagnosticsQuerySpecs(now: Date): Record<string, QuerySpec> {
  const specs: Record<string, QuerySpec> = {};
  for (const [name, spec] of Object.entries(diagnosticsSpecs(now))) {
    specs[`diagnostics:${name}`] = spec;
  }
  for (const stage of ['s2', 's3'] as const) {
    for (const [name, spec] of Object.entries(queuedCountSpecs(stage))) {
      specs[`diagnostics:queued-${stage}-${name}`] = spec;
    }
  }
  return specs;
}

/** A required index isn't built yet (Firestore `failed-precondition`). */
export class IndexBuildingError extends Error {
  override name = 'IndexBuildingError';
}

export function diagnosticsErrorMessage(error: unknown): string {
  if (error instanceof IndexBuildingError) {
    return 'Index building: a new index is still being created. Try again in a few minutes.';
  }
  return "Couldn't read the funnel numbers. Try again.";
}

function guard<T>(label: string, run: () => Promise<T>): Promise<T> {
  return withRetry(() => withTimeout(run(), READ_TIMEOUT_MS, label), {
    label: `diagnostics.${label}`,
    isRetryable: isTransient,
  }).catch((error: unknown) => {
    const code = errorCode(error) ?? 'unknown';
    logError('diagnostics.read_failed', { label, code });
    if (code === 'failed-precondition') throw new IndexBuildingError(label);
    throw error;
  });
}

interface LoadedJob {
  id: string;
  job: Job;
}

async function readSet(source: Query): Promise<LoadedJob[]> {
  const snapshot = await guard('jobs', () => getDocs(source));
  const jobs: LoadedJob[] = [];
  let invalid = 0;
  for (const item of snapshot.docs) {
    const read = readJob(item);
    if (read.ok) jobs.push({ id: read.view.id, job: read.view.job });
    else invalid++;
  }
  if (invalid > 0) logError('diagnostics.invalid_jobs', { count: invalid });
  return jobs;
}

/**
 * The C1 to C4 candidates are title rules, which run before anything reads a description, so the
 * panel loads none. PR B adds the description reads when C5 and C6 need them.
 */
const withoutTexts = (jobs: readonly LoadedJob[]): DiagnosticJob[] =>
  jobs.map((entry) => ({ job: entry.job, text: '' }));

async function count(source: Query, label: string): Promise<number | null> {
  try {
    return (await guard(label, () => getCountFromServer(source))).data().count;
  } catch (error) {
    if (error instanceof IndexBuildingError) throw error;
    return null;
  }
}

async function loadCriteria(): Promise<CriteriaContent | null> {
  const { db } = await getFirebase();
  const pointer = await guard('criteria', () => getDoc(doc(db, DOCS.criteriaCurrent)));
  const parsedPointer = CriteriaPointerSchema.safeParse(timestampsToDates(pointer.data()));
  if (!parsedPointer.success) return null;
  const version = await guard('criteria', () =>
    getDoc(doc(db, PATHS.criteriaVersion(criteriaVersionId(parsedPointer.data.version)))),
  );
  const parsed = CriteriaVersionSchema.safeParse(timestampsToDates(version.data()));
  return parsed.success ? parsed.data : null;
}

async function loadWorkRights(): Promise<WorkRights | null> {
  const { db } = await getFirebase();
  const snapshot = await guard('work-rights', () => getDoc(doc(db, DOCS.profileMain)));
  const parsed = ProfileSettingsSchema.safeParse(timestampsToDates(snapshot.data()));
  return parsed.success ? parsed.data.workRights : null;
}

/**
 * Reads the three sets, then returns the counts. Throws
 * `IndexBuildingError` while the new `(skip.stage, judgedAt)` index is still building.
 */
export async function loadDiagnostics(now: Date): Promise<DiagnosticsReport> {
  const { db } = await getFirebase();
  const specs = diagnosticsSpecs(now);
  const jobs = collection(db, COLLECTIONS.jobs);
  const run = (spec: QuerySpec) =>
    query(jobs, ...specConstraints(spec), limit(DIAGNOSTICS_READ_LIMIT));

  const [criteria, workRights] = await Promise.all([loadCriteria(), loadWorkRights()]);
  if (!criteria) throw new Error('No criteria yet.');

  const [skips, good, queued] = await Promise.all([
    readSet(run(specs.s2Skips)),
    readSet(run(specs.good)),
    readSet(run(specs.queuedS3)),
  ]);

  const s2Skipped = withoutTexts(skips.filter((entry) => isModelSkip(entry.job)));
  const goodJobs = withoutTexts(good);
  const queuedS3 = withoutTexts(queued);

  const [s2All, s2Sorted, s3All, s3Sorted] = await Promise.all([
    count(query(jobs, ...specConstraints(queuedCountSpecs('s2').all)), 'queued-s2'),
    count(query(jobs, ...specConstraints(queuedCountSpecs('s2').withSortAt)), 'queued-s2-sorted'),
    count(query(jobs, ...specConstraints(queuedCountSpecs('s3').all)), 'queued-s3'),
    count(query(jobs, ...specConstraints(queuedCountSpecs('s3').withSortAt)), 'queued-s3-sorted'),
  ]);
  const missing = (all: number | null, sorted: number | null) =>
    all === null || sorted === null ? null : Math.max(0, all - sorted);

  return buildReport({
    sets: { s2Skipped, good: goodJobs, queuedS3 },
    criteria,
    workRights,
    now,
    queuedWithoutSortAt: { s2: missing(s2All, s2Sorted), s3: missing(s3All, s3Sorted) },
  });
}
