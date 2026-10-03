import { FUNCTIONS_REGION, type ModelPrice } from '@hireframe/shared';

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

/** PRD R11 default monthly cap (£15). */
export const DEFAULT_MONTHLY_CAP_PENCE = 1500;

/** Deliberately high, so costs in pence are overstated rather than understated. */
export const DEFAULT_FX_USD_TO_GBP = 0.85;

export type LlmPurpose = 'parseCv' | 'addFact';

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
 * One model per purpose (ADR-016): Sonnet-class for the CV parse, Haiku-class for addFact.
 * Each budget plus `LLM.callableMarginMs` fits inside its callable's timeout (config.test.ts).
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
};

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

/** USD per million tokens (Anthropic list prices). Unknown models are charged at the top rate. */
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
  /** No request starts after this much of the run; the rest is dedupe and writes. */
  fetchBudgetMs: 360_000,
  /** A lock older than this belongs to a scan that died (callable timeout is 9 min). */
  lockStaleMs: 12 * 60_000,
  /** A manual scan this soon after the last one is skipped (double taps, ADR-029). */
  cooldownMs: 5 * 60_000,
  emulatorCooldownMs: 30_000,
  /** Firestore allows 500 writes per batch. */
  writeBatchOps: 400,
  /** `array-contains-any` takes at most 30 values. */
  keyLookupChunk: 30,
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
  // Workable rate-limits (Cloudflare 1015) at 1 request/s; its documented endpoint redirects to
  // apply.workable.com, so both hosts are spaced (ADR-027).
  'www.workable.com': { intervalMs: 5_000 },
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
  adzuna: { resultsPerPage: 50 },
  hn: { maxComments: 1_500 },
} as const;
