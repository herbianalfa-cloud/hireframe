import type { ModelPrice } from '@hireframe/shared';

/**
 * Functions configuration (CLAUDE.md: config lives here or in Firestore `config/*`).
 * `config/app.monthlyCapPence` and `config/app.fxUsdToGbp` override the defaults below.
 */

export const REGION = 'europe-west2';

/** Dedicated runtime account (ADR-017); the trailing `@` expands to the project's domain. */
export const RUNTIME_SERVICE_ACCOUNT = 'hireframe-fns@';

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
  /** Per-attempt request timeout; the SDK retries up to twice. */
  timeoutMs: number;
}

/** One model per purpose (ADR-016): Sonnet-class for the CV parse, Haiku-class for addFact. */
export const MODELS: Readonly<Record<LlmPurpose, ModelConfig>> = {
  parseCv: { id: 'claude-sonnet-5-5', effort: 'medium', maxTokens: 32_000, timeoutMs: 150_000 },
  addFact: { id: 'claude-haiku-4-5', maxTokens: 4_000, timeoutMs: 45_000 },
};

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
  /** parseCv waits for a long model call: 3 attempts at most, each bounded by timeoutMs. */
  parseCvTimeoutSeconds: 540,
  addFactTimeoutSeconds: 120,
  memory: '1GiB',
} as const;

/** Re-upload merge (packages/shared/src/merge.ts). */
export const MERGE = { similar: 0.6 } as const;

/** Less extracted text than this means a scanned or empty file. */
export const MIN_CV_TEXT_CHARS = 200;

/** A document stuck in `parsing` longer than this may be parsed again. */
export const STALE_PARSE_MS = 15 * 60 * 1000;
