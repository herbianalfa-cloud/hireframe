import { z } from 'zod';

import { CALLABLE_TIMEOUT_SECONDS } from './callables.js';

/**
 * Jobs, sources, runs and companies (docs/ARCHITECTURE.md "Data model", ADR-029, ADR-030).
 * - `RawJob`: what a source module returns, before normalisation. Source modules build it from
 *   zod-parsed API responses; the scan re-validates every item against this schema.
 * - `jobs/{jobId}` + `jobs/{jobId}/description/raw`: a deduped job and its full text.
 * - `runs/{runId}`, `sources/{sourceId}`, `companies/{companyId}`: server-written only.
 *
 * Timestamps are `Date`s so the schemas stay SDK-agnostic; callers convert Firestore
 * `Timestamp`s before parsing.
 */

/** Sources the scan fetches (one module each, functions/src/sources/). */
export const SCAN_SOURCE_IDS = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'reed',
  'adzuna',
  'hn',
] as const;
export type ScanSourceId = (typeof SCAN_SOURCE_IDS)[number];

/** Every source a job can come from: the scan sources plus email alerts (M6). */
export const JOB_SOURCE_IDS = [...SCAN_SOURCE_IDS, 'linkedin-alert'] as const;
export type JobSourceId = (typeof JOB_SOURCE_IDS)[number];

export const ATS_TYPES = ['greenhouse', 'lever', 'ashby', 'workable', 'none'] as const;
export type AtsType = (typeof ATS_TYPES)[number];

export const REMOTE_MODES = ['remote', 'hybrid', 'onsite', 'unknown'] as const;
export type RemoteMode = (typeof REMOTE_MODES)[number];

/** `GB`, somewhere recognisably outside the UK, or not known (S1 passes unknown, M4). */
export const COUNTRIES = ['GB', 'other', 'unknown'] as const;
export type Country = (typeof COUNTRIES)[number];

export const DESCRIPTION_KINDS = ['full', 'snippet'] as const;
export type DescriptionKind = (typeof DESCRIPTION_KINDS)[number];

export const JOB_STAGES = ['s0', 's1', 's2', 's3'] as const;
export const JOB_STATUSES = [
  'new',
  'saved',
  'applied',
  'skipped',
  'interview',
  'offer',
  'rejected',
] as const;

export const JOB_LIMITS = {
  title: 300,
  company: 200,
  location: 500,
  url: 2000,
  externalId: 200,
  /** Stored description text; Firestore documents max out at 1 MiB. */
  description: 50_000,
  /** Raw description bodies before conversion (HTML is longer than its text). */
  rawDescription: 400_000,
  keys: 60,
  sources: 20,
  extraUrls: 20,
} as const;

const HttpUrl = z.url({ protocol: /^https?$/ }).max(JOB_LIMITS.url);

export const SalarySchema = z.object({
  min: z.number().nonnegative().exactOptional(),
  max: z.number().nonnegative().exactOptional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  period: z.enum(['year', 'month', 'day', 'hour', 'unknown']),
});
export type Salary = z.infer<typeof SalarySchema>;

export const RawJobSchema = z.object({
  sourceId: z.enum(JOB_SOURCE_IDS),
  externalId: z.string().trim().min(1).max(JOB_LIMITS.externalId),
  url: HttpUrl,
  title: z.string().trim().min(1).max(JOB_LIMITS.title),
  company: z.string().trim().min(1).max(JOB_LIMITS.company),
  /** Set by ATS sources, which know the watchlist company they fetched. */
  companyId: z.string().min(1).exactOptional(),
  locationText: z.string().trim().max(JOB_LIMITS.location),
  /** A structured remote flag from the API, when it has one. */
  remoteHint: z.enum(REMOTE_MODES).exactOptional(),
  description: z.object({
    kind: z.enum(DESCRIPTION_KINDS),
    format: z.enum(['html', 'text']),
    body: z.string().max(JOB_LIMITS.rawDescription),
  }),
  postedAt: z.date().exactOptional(),
  salary: SalarySchema.exactOptional(),
  /** Other job links in the posting (e.g. an HN comment linking a Greenhouse job). */
  extraUrls: z.array(HttpUrl).max(JOB_LIMITS.extraUrls).exactOptional(),
});
export type RawJob = z.infer<typeof RawJobSchema>;

export const JobSourceRefSchema = z.object({
  id: z.enum(JOB_SOURCE_IDS),
  url: HttpUrl,
  externalId: z.string().min(1).max(JOB_LIMITS.externalId),
  seenAt: z.date(),
});
export type JobSourceRef = z.infer<typeof JobSourceRefSchema>;

/**
 * `jobs/{jobId}` (M3 fields). M4 adds the verdict fields and `criteriaVersion` when it judges
 * the job; until then a job waits at stage `s0`.
 */
export const JobSchema = z.object({
  dedupeKey: z.string().min(1),
  keys: z.array(z.string().min(1)).min(1).max(JOB_LIMITS.keys),
  title: z.string().min(1).max(JOB_LIMITS.title),
  company: z.string().min(1).max(JOB_LIMITS.company),
  companyId: z.string().min(1).exactOptional(),
  location: z.string().max(JOB_LIMITS.location),
  city: z.string(),
  country: z.enum(COUNTRIES),
  remote: z.enum(REMOTE_MODES),
  url: HttpUrl,
  sources: z.array(JobSourceRefSchema).min(1).max(JOB_LIMITS.sources),
  postedAt: z.date().exactOptional(),
  firstSeenAt: z.date(),
  descriptionRef: z.string().min(1),
  descriptionKind: z.enum(DESCRIPTION_KINDS),
  salary: SalarySchema.exactOptional(),
  stage: z.enum(JOB_STAGES),
  status: z.enum(JOB_STATUSES),
  createdAt: z.date(),
  updatedAt: z.date(),
  schemaVersion: z.literal(1),
});
export type Job = z.infer<typeof JobSchema>;

/** `jobs/{jobId}/description/raw`. Untrusted text: data for the funnel, never instructions. */
export const JobDescriptionSchema = z.object({
  text: z.string().max(JOB_LIMITS.description),
  kind: z.enum(DESCRIPTION_KINDS),
  sourceId: z.enum(JOB_SOURCE_IDS),
  fetchedAt: z.date(),
  schemaVersion: z.literal(1),
});
export type JobDescription = z.infer<typeof JobDescriptionSchema>;

// ---- Source health and runs ----

/**
 * ok: everything fetched. degraded: some boards or queries failed. failing: nothing fetched.
 * disabled: turned off (`config/app.disabledSources`, or a missing API key).
 * skipped: nothing to do (no watched companies of that ATS, no criteria, quota used up).
 */
export const SOURCE_STATUSES = ['ok', 'degraded', 'failing', 'disabled', 'skipped'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

const Count = z.int().min(0);
const ErrorCode = z.string().regex(/^[a-z0-9_]{1,60}$/);

export const SourceRunCountsSchema = z.object({
  status: z.enum(SOURCE_STATUSES),
  /** Postings the API returned (valid or not). */
  fetched: Count,
  /** Postings that failed RawJobSchema or normalisation. */
  invalid: Count,
  /** Jobs this source created. */
  new: Count,
  /** Postings already on a known job from this source. */
  duplicate: Count,
  /** Postings that added this source to a job another source (or an earlier run) found. */
  merged: Count,
  /** Failed boards, queries or pages. */
  errors: Count,
  requests: Count,
  durationMs: Count,
  errorCode: ErrorCode.exactOptional(),
});
export type SourceRunCounts = z.infer<typeof SourceRunCountsSchema>;

/** Persisted API call counters (ADR-025). Periods are Europe/London calendar keys. */
export const QuotaSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dayCount: Count,
  week: z.string().regex(/^\d{4}-W\d{2}$/),
  weekCount: Count,
  month: z.string().regex(/^\d{4}-\d{2}$/),
  monthCount: Count,
});
export type Quota = z.infer<typeof QuotaSchema>;

/** `sources/{sourceId}`: rolling health for the System screen (ADR-029). */
export const SourceHealthSchema = z.object({
  status: z.enum(SOURCE_STATUSES),
  lastRunAt: z.date(),
  lastOkAt: z.date().exactOptional(),
  consecutiveFailures: Count,
  lastErrorCode: ErrorCode.exactOptional(),
  lastCounts: SourceRunCountsSchema,
  quota: QuotaSchema.exactOptional(),
  /** Where Reed/Adzuna query rotation continues next run. */
  queryCursor: Count.exactOptional(),
  updatedAt: z.date(),
  schemaVersion: z.literal(1),
});
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

export const RUN_STATUSES = ['running', 'succeeded', 'partial', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const S0CountsSchema = z.object({
  in: Count,
  new: Count,
  merged: Count,
  duplicate: Count,
  conflicts: Count,
});
export type S0Counts = z.infer<typeof S0CountsSchema>;

export const RunSchema = z.object({
  trigger: z.enum(['manual', 'schedule']),
  status: z.enum(RUN_STATUSES),
  startedAt: z.date(),
  finishedAt: z.date().exactOptional(),
  perSource: z.partialRecord(z.enum(SCAN_SOURCE_IDS), SourceRunCountsSchema),
  perStage: z.object({ s0: S0CountsSchema.exactOptional() }),
  costPence: z.number().min(0),
  /** Codes only, never messages (docs/SECURITY.md "Sensitive data in logs"). */
  errors: z
    .array(z.object({ sourceId: z.enum(SCAN_SOURCE_IDS).exactOptional(), code: ErrorCode }))
    .max(50),
  schemaVersion: z.literal(1),
});
export type Run = z.infer<typeof RunSchema>;

/**
 * A run still `running` this long after it started was killed (callable timeout or memory) before
 * it could record its end. The UI shows it as timed out; the next scan marks it failed.
 */
export const STALE_RUN_MS = (CALLABLE_TIMEOUT_SECONDS.scanNow + 60) * 1000;

export function isRunStalled(run: Pick<Run, 'status' | 'startedAt'>, now: Date): boolean {
  return run.status === 'running' && now.getTime() - run.startedAt.getTime() >= STALE_RUN_MS;
}

/** What a scan reads from stored jobs to dedupe against them (a `select` projection). */
export const JobKeysProjectionSchema = z.object({
  keys: z.array(z.string().min(1)).min(1),
  firstSeenAt: z.date(),
  sources: z.array(z.unknown()),
});

// ---- Companies (watchlist) ----

export const AtsSchema = z
  .object({
    type: z.enum(ATS_TYPES),
    token: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,100}$/)
      .exactOptional(),
    /** Lever boards hosted in the EU live on api.eu.lever.co. */
    host: z.literal('eu').exactOptional(),
  })
  .refine((ats) => (ats.type === 'none') === (ats.token === undefined), {
    message: 'a board token is required for an ATS, and only then',
  });
export type Ats = z.infer<typeof AtsSchema>;

export const COMPANY_SCAN_STATUSES = ['ok', 'not_found', 'error'] as const;

/** A board that returned `not_found` this many runs in a row is shown as broken. */
export const BROKEN_BOARD_AFTER = 3;

export const CompanySchema = z.object({
  name: z.string().min(1).max(JOB_LIMITS.company),
  domain: z.string().min(1).max(253),
  ats: AtsSchema,
  size: z.string().max(40).exactOptional(),
  stage: z.string().max(40).exactOptional(),
  hq: z.string().max(100),
  watch: z.boolean(),
  origin: z.enum(['seed', 'manual', 'detected']),
  lastScannedAt: z.date().exactOptional(),
  lastScan: z
    .object({
      status: z.enum(COMPANY_SCAN_STATUSES),
      jobs: Count,
      consecutiveFailures: Count,
      broken: z.boolean(),
      errorCode: ErrorCode.exactOptional(),
    })
    .exactOptional(),
  createdAt: z.date(),
  updatedAt: z.date(),
  schemaVersion: z.literal(1),
});
export type Company = z.infer<typeof CompanySchema>;

// ---- scanNow callable ----

export const ScanNowInputSchema = z.strictObject({});

const SourceRunSummarySchema = SourceRunCountsSchema.pick({
  status: true,
  fetched: true,
  new: true,
  duplicate: true,
  merged: true,
  errors: true,
});

export const ScanNowResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    runId: z.string().min(1),
    runStatus: z.enum(['succeeded', 'partial', 'failed']),
    perSource: z.partialRecord(z.enum(SCAN_SOURCE_IDS), SourceRunSummarySchema),
    s0: S0CountsSchema,
  }),
  z.object({
    status: z.literal('skipped_recent'),
    /** ISO time the previous scan finished. */
    lastFinishedAt: z.string(),
    retryAfterSeconds: z.int().min(0),
  }),
]);
export type ScanNowResult = z.infer<typeof ScanNowResultSchema>;

/** `locks/scan`: the single-flight scan lock (ADR-029). `runId` is set only while a scan runs. */
export const ScanLockSchema = z.object({
  runId: z.string().min(1).exactOptional(),
  startedAt: z.date().exactOptional(),
  lastFinishedAt: z.date().exactOptional(),
  schemaVersion: z.literal(1),
});
export type ScanLock = z.infer<typeof ScanLockSchema>;

/** One watchlist seed entry (ADR-031): public facts only. `id` is the `companies/{id}` doc ID. */
export const CompanySeedSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  name: z.string().trim().min(1).max(JOB_LIMITS.company),
  domain: z
    .string()
    .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/)
    .max(253),
  ats: AtsSchema,
  hq: z.string().min(1).max(100),
  size: z.string().max(40).exactOptional(),
  stage: z.string().max(40).exactOptional(),
});
export type CompanySeed = z.infer<typeof CompanySeedSchema>;
