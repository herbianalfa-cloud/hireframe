import {
  FUNCTIONS_REGION,
  INGEST_WIRE,
  type CallableName,
  type ModelPrice,
} from '@hireframe/shared';
import { z } from 'zod';

/**
 * Functions configuration (CLAUDE.md: config lives here or in Firestore `config/*`).
 * `config/app.monthlyCapPence` and `config/app.fxUsdToGbp` override the defaults below.
 */

/** Shared with the web client (packages/shared/src/callables.ts). */
export const REGION = FUNCTIONS_REGION;

/**
 * Dedicated runtime account (ADR-017). Always the full email: the `name@` shorthand is not
 * accepted everywhere (Secret Manager's setIamPolicy rejects it, which failed the v0.2.0 deploy).
 */
export const RUNTIME_SERVICE_ACCOUNT = 'hireframe-fns@hireframe-f6b03.iam.gserviceaccount.com';

/** Secret Manager secret name read through `defineSecret` (docs/RUNBOOK.md Part C). */
export const ANTHROPIC_SECRET_NAME = 'ANTHROPIC_API_KEY';

/** Secret Manager name of the Gmail bridge's HMAC secret (docs/RUNBOOK.md Part G). */
export const INGEST_HMAC_SECRET_NAME = 'INGEST_HMAC_SECRET';

/** Deliberately high, so costs in pence are overstated rather than understated. */
export const DEFAULT_FX_USD_TO_GBP = 0.85;

export type LlmPurpose = 'parseCv' | 'addFact' | 'triage' | 'deepRead' | 'alertParse';

export interface ModelConfig {
  id: string;
  maxTokens: number;
  /** Omitted for models that reject the effort parameter (Haiku 4.5). */
  effort?: 'low' | 'medium' | 'high';
  /**
   * Hard limit for one send, streamed body and SDK retries included (an AbortSignal; the SDK's
   * own `timeout` stops counting once response headers arrive).
   */
  timeoutMs: number;
  /** Wall-clock budget for the whole `llm.call()`, every attempt included. */
  budgetMs: number;
}

/**
 * One model per purpose (ADR-016, ADR-035): Sonnet-class for the CV parse and the S3 deep read,
 * Haiku-class for addFact and S2 triage. Each budget plus `LLM.callableMarginMs` fits inside its
 * callable's timeout, and the funnel's last call ends before the scan callable does
 * (config.test.ts). `deepRead` keeps max_tokens low because every in-flight call reserves its
 * worst case against the run's lease (ADR-032).
 */
export const MODELS: Readonly<Record<LlmPurpose, ModelConfig>> = {
  parseCv: {
    id: 'claude-sonnet-5-5',
    effort: 'medium',
    maxTokens: 32_000,
    timeoutMs: 240_000,
    budgetMs: 480_000,
  },
  addFact: { id: 'claude-haiku-4-5', maxTokens: 4_000, timeoutMs: 45_000, budgetMs: 90_000 },
  triage: { id: 'claude-haiku-4-5', maxTokens: 1_000, timeoutMs: 25_000, budgetMs: 45_000 },
  deepRead: {
    id: 'claude-sonnet-5-5',
    effort: 'low',
    maxTokens: 4_000,
    timeoutMs: 40_000,
    budgetMs: 60_000,
  },
  /** Alert emails from senders with no deterministic parser (ADR-047). */
  alertParse: { id: 'claude-haiku-4-5', maxTokens: 3_000, timeoutMs: 15_000, budgetMs: 35_000 },
};

/** The callable whose timeout bounds each purpose's calls. */
export const PURPOSE_CALLABLE = {
  parseCv: 'parseCv',
  addFact: 'addFact',
  triage: 'scanNow',
  deepRead: 'scanNow',
  alertParse: 'ingestEmailJobs',
} as const satisfies Record<LlmPurpose, CallableName>;

export const LLM = {
  /** Hard limit for a token count, SDK retries included. */
  countTokensTimeoutMs: 20_000,
  /** A retry starts only if this much of the budget is left after counting tokens. */
  minSendMs: 10_000,
  /** Time a callable needs outside `llm.call()`: download, extraction, Firestore writes. */
  callableMarginMs: 30_000,
} as const;

/**
 * The emulator's fake transport reports `fake:<model id>`, so fake spend is never mistaken for
 * real spend in `usage/*` or on a parsed document. It is priced at the real model's rate.
 */
export const FAKE_MODEL_PREFIX = 'fake:';

/**
 * USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing (checked
 * 2026-10-03, ADR-032). Unknown models are charged at the top rate.
 */
export const PRICES_USD_PER_MTOK: Readonly<Record<string, ModelPrice>> = {
  'claude-sonnet-5-5': {
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 10,
    cacheReadUsdPerMTok: 0.2,
    cacheWriteUsdPerMTok: 2.5,
  },
  'claude-haiku-4-5': {
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    cacheReadUsdPerMTok: 0.1,
    cacheWriteUsdPerMTok: 1.25,
  },
};

export const TOP_PRICE: ModelPrice = Object.values(PRICES_USD_PER_MTOK).reduce((top, price) => ({
  inputUsdPerMTok: Math.max(top.inputUsdPerMTok, price.inputUsdPerMTok),
  outputUsdPerMTok: Math.max(top.outputUsdPerMTok, price.outputUsdPerMTok),
  cacheReadUsdPerMTok: Math.max(top.cacheReadUsdPerMTok, price.cacheReadUsdPerMTok),
  cacheWriteUsdPerMTok: Math.max(top.cacheWriteUsdPerMTok, price.cacheWriteUsdPerMTok),
}));

export const CALLABLE = {
  memory: '1GiB',
} as const;

/** Re-upload merge (packages/shared/src/merge.ts). */
export const MERGE = { similar: 0.6 } as const;

/** Less extracted text than this means a scanned or empty file. */
export const MIN_CV_TEXT_CHARS = 200;

// ---- Sources and scanning (M3, ADR-025, ADR-029) ----

/** Secret Manager names for the keyed job APIs; mounted on `scanNow` only. */
export const SOURCE_SECRET_NAMES = {
  reedApiKey: 'REED_API_KEY',
  adzunaAppId: 'ADZUNA_APP_ID',
  adzunaAppKey: 'ADZUNA_APP_KEY',
} as const;

export const SCAN = {
  productToken: 'HireframeBot',
  userAgent: 'HireframeBot/0.3 (+https://github.com/herbianalfa-cloud/hireframe)',
  maxAttempts: 3,
  backoffBaseMs: 1_000,
  /** A Retry-After longer than this fails the request instead of stalling the run. */
  retryAfterCapMs: 30_000,
  /** Largest response body read (a big Greenhouse board with content or an HN thread). */
  maxBodyBytes: 20 * 1024 * 1024,
  /** No request starts after this much of the run; the rest is dedupe, writes and the funnel. */
  fetchBudgetMs: 300_000,
  /** A lock older than this belongs to a scan that died (callable timeout is 9 min). */
  lockStaleMs: 12 * 60_000,
  /** A manual scan this soon after the last one is skipped (double taps, ADR-029). */
  cooldownMs: 5 * 60_000,
  emulatorCooldownMs: 30_000,
  /** Firestore allows 500 writes per batch. */
  writeBatchOps: 400,
  /** `array-contains-any` takes at most 30 values. */
  keyLookupChunk: 30,
  /** Key-lookup queries in flight at once. */
  keyLookupConcurrency: 8,
  /** Seed company refs read per `getAll`. */
  seedReadChunk: 200,
  /** Candidates detect-ats checks at once; each host is still spaced by its interval. */
  detectWorkers: 4,
  /** ATS boards fetched at once per source; each host is still spaced by its interval. */
  boardConcurrency: 4,
  /**
   * Share of the fetch budget one ATS host's boards may fill. A host with more boards than fit
   * (count × its interval) rotates: the least recently scanned go first, the rest wait a run.
   * Workable at 5 s gets 43 boards a run; Greenhouse at 1 s gets 216 (ADR-029).
   */
  boardTimeShare: 0.6,
} as const;

export interface HostPolicyConfig {
  robots: 'enforce' | 'api-terms';
  intervalMs: number;
  timeoutMs: number;
}

const DEFAULT_HOST_POLICY: HostPolicyConfig = {
  robots: 'enforce',
  intervalMs: 1_000,
  timeoutMs: 20_000,
};

/**
 * Per-host overrides. `api-terms` hosts are keyed APIs that follow their developer terms
 * instead of robots.txt (ADR-025); adding one needs an ADR.
 */
const HOST_POLICIES: Readonly<Record<string, Partial<HostPolicyConfig>>> = {
  'www.reed.co.uk': { robots: 'api-terms', intervalMs: 1_000 },
  // 20 requests a minute, under Adzuna's 25.
  'api.adzuna.com': { robots: 'api-terms', intervalMs: 3_000 },
  // Workable rate-limits (Cloudflare 1015) at 1 request/s. Called directly on
  // apply.workable.com, where its documented endpoint redirects, so no redirect skips the
  // host's robots check or spacing (ADR-027).
  'apply.workable.com': { intervalMs: 5_000 },
  // A whole "Who is hiring?" thread is a few MB.
  'hn.algolia.com': { timeoutMs: 45_000 },
};

export function hostPolicy(host: string): HostPolicyConfig {
  return { ...DEFAULT_HOST_POLICY, ...HOST_POLICIES[host.toLowerCase()] };
}

export const API_TERMS_HOSTS = Object.entries(HOST_POLICIES)
  .filter(([, policy]) => policy.robots === 'api-terms')
  .map(([host]) => host);

export interface QuotaLimits {
  perRun: number;
  perDay: number;
  perWeek: number;
  perMonth: number;
}

/**
 * API call budgets (ADR-025). Adzuna: 25/min, 250/day, 1,000/week, 2,500/month, kept 10%
 * under. Reed: terms not published; a conservative budget until its clauses are cited.
 */
export const QUOTAS = {
  adzuna: { perRun: 20, perDay: 225, perWeek: 900, perMonth: 2_250 },
  reed: { perRun: 30, perDay: 300, perWeek: 1_500, perMonth: 6_000 },
} as const satisfies Record<string, QuotaLimits>;

export const SOURCE_QUERIES = {
  reed: { resultsToTake: 100, distanceMiles: 20 },
  adzuna: { resultsPerPage: 50, country: 'gb' },
  hn: { maxComments: 1_500 },
} as const;

// ---- Funnel (M4, ADR-032) ----

export const FUNNEL = {
  /** Weekday runs at 07:30 and 17:30: at most 23 weekdays a month. */
  scheduledRunsPerMonth: 46,
  /** Share of the monthly cap the scheduled runs may use; the rest is for manual work. */
  scheduledShare: 0.75,
  /** S2 may use at most this share of a run's lease, so it can't starve S3. */
  s2Share: 0.4,
  /** From this share of the monthly cap a run is flagged `spend_80` (PRD R11). */
  warnAtFraction: 0.8,
  /** From this share of the monthly cap S3 pauses; S2 continues until the cap (PRD R11). */
  deepPauseAtFraction: 0.9,
  s1MaxJobs: 2_000,
  /**
   * A job whose description is shorter than this (or has none) is never deep-read: it waits for a
   * description instead, free (M6, ADR-048).
   */
  minDeepReadChars: 200,
  /** Queued jobs past `freshness_days` the expiry sweep reads per stage and run (free). */
  expireMaxJobs: 2_000,
  s2MaxJobs: 300,
  s3MaxJobs: 32,
  s2Concurrency: 4,
  s3Concurrency: 2,
  /** Request starts per minute, under Anthropic's rate limits for the account's tier. */
  triageRpm: 45,
  deepReadRpm: 20,
  /** Reed details calls for full text, per run (they count against Reed's quotas too). */
  reedHydratePerRun: 20,
  /** From the run's start: no new S2 call after this, nor a new S3 call after the next. */
  s2StopMs: 400_000,
  s3StopMs: 450_000,
  /** Description and company reads per `getAll`. */
  readChunk: 100,
  /** Jobs a re-score looks at, at most (first seen in the last 14 days). */
  rescoreMaxJobs: 2_000,
} as const;

/** Per-run lease when `config/app.funnel.runBudgetPence` isn't set: 24p at a £15 cap. */
export function defaultRunBudgetPence(monthlyCapPence: number): number {
  return Math.floor((monthlyCapPence * FUNNEL.scheduledShare) / FUNNEL.scheduledRunsPerMonth);
}

/**
 * Optional `config/app.funnel` overrides, changed in the console without a deploy. Parsed on its
 * own (AppConfigSchema keeps it as unknown), so a typo can't fail the owner check: an invalid
 * object is logged and ignored.
 */
export const FunnelOverridesSchema = z
  .object({
    runBudgetPence: z.number().min(0).max(1_000),
    s1MaxJobs: z.int().min(0).max(5_000),
    s2MaxJobs: z.int().min(0).max(300),
    s3MaxJobs: z.int().min(0).max(60),
    triageRpm: z.int().min(1).max(1_000),
    deepReadRpm: z.int().min(1).max(1_000),
    reedHydratePerRun: z.int().min(0).max(30),
  })
  .partial();
export type FunnelOverrides = z.infer<typeof FunnelOverridesSchema>;

export interface FunnelLimits {
  runBudgetPence: number;
  s1MaxJobs: number;
  /** Stale queued jobs the expiry sweep reads per stage and run. */
  expireMaxJobs: number;
  s2MaxJobs: number;
  s3MaxJobs: number;
  triageRpm: number;
  deepReadRpm: number;
  reedHydratePerRun: number;
}

export function funnelLimits(monthlyCapPence: number, overrides: FunnelOverrides): FunnelLimits {
  return {
    runBudgetPence: overrides.runBudgetPence ?? defaultRunBudgetPence(monthlyCapPence),
    s1MaxJobs: overrides.s1MaxJobs ?? FUNNEL.s1MaxJobs,
    expireMaxJobs: FUNNEL.expireMaxJobs,
    s2MaxJobs: overrides.s2MaxJobs ?? FUNNEL.s2MaxJobs,
    s3MaxJobs: overrides.s3MaxJobs ?? FUNNEL.s3MaxJobs,
    triageRpm: overrides.triageRpm ?? FUNNEL.triageRpm,
    deepReadRpm: overrides.deepReadRpm ?? FUNNEL.deepReadRpm,
    reedHydratePerRun: overrides.reedHydratePerRun ?? FUNNEL.reedHydratePerRun,
  };
}

// ---- Gmail bridge (M6, ADR-046, ADR-047, ADR-048) ----

/** Request signing: the nonce outlives the skew twice over, so a replay is always caught. */
export const HMAC = {
  /** A signed request is accepted when its timestamp is within this of the server's clock. */
  maxSkewSeconds: 300,
  /** A nonce is remembered this long (a TTL policy on `nonces.expireAt` deletes it). */
  nonceTtlSeconds: 600,
} as const;

export const ALERTS = {
  /** Messages per request, and the wire limits the script truncates to (shared with it). */
  maxMessagesPerRequest: INGEST_WIRE.messagesPerRequest,
  maxBodyBytes: INGEST_WIRE.serverMaxBytes,
  /**
   * Model calls start only within this of the request starting. UrlFetchApp gives up at ~60 s, so
   * this plus the `alertParse` budget stays within 50 s (config.test.ts).
   */
  modelWindowMs: 15_000,
  /** `alertMessages` documents are kept this long (a TTL policy on `expireAt`). */
  messageTtlDays: 30,
  /** Daily spend on alert parsing; `config/app.alerts.dailyCapPence` overrides it. */
  dailyCapPence: 10,
  /** Senders listed individually in `sources/email.bySender`; the rest count under `other`. */
  maxSenderDomains: 20,
  /** Jobs the model may return for one email. */
  maxModelJobs: 30,
  /** Links offered to the model, numbered. */
  maxModelLinks: 60,
  /** Characters of email text sent to the model. */
  maxModelChars: 20_000,
} as const;

/** The email-ingest lock: a killed ingest blocks scans for this long, not the scan's 12 min. */
export const SHORT_LOCK = {
  /** The ingest function's timeout plus a margin. */
  emailStaleMs: 3 * 60_000,
  /** A scheduled scan waits this often, and this long, for an `email` or `lookup` holder. */
  scheduledWaitIntervalMs: 15_000,
  scheduledWaitMaxMs: 4 * 60_000,
} as const;

/**
 * Link hosts an alert may point at and still be trusted for keys and the job's own URL: the ATS
 * hosts, LinkedIn, Reed, Adzuna, Indeed, Wellfound, Work at a Startup, Escape the City, WTTJ.
 * Any other https link keeps the job but is stored unverified, on the source ref only.
 */
export const ALERT_LINK_HOSTS = [
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'workable.com',
  'linkedin.com',
  'reed.co.uk',
  'adzuna.co.uk',
  'indeed.com',
  'indeed.co.uk',
  'wellfound.com',
  'workatastartup.com',
  'escapethecity.org',
  'welcometothejungle.com',
] as const;

/**
 * Optional `config/app.alerts` override, parsed on its own like `config/app.funnel` so a typo
 * can't fail the owner check: an invalid object is ignored.
 */
export const AlertOverridesSchema = z
  .object({ dailyCapPence: z.number().min(0).max(200) })
  .partial();

/** PRD R4: 07:30 and 17:30 on weekdays, UK time (Cloud Scheduler handles the clock change). */
export const SCHEDULE = {
  cron: '30 7,17 * * 1-5',
  timeZone: 'Europe/London',
} as const;
