/** Thrown before any API call when the call's worst case would exceed the monthly cap. */
export class SpendCapExceededError extends Error {
  override name = 'SpendCapExceededError';
}

/**
 * Thrown before any API call when a call would pass its purpose's daily cap (ADR-047). The month
 * may have room; the day doesn't. Callers defer the work rather than fail it.
 */
export class DailyCapExceededError extends Error {
  override name = 'DailyCapExceededError';
}

export type LlmOutputFailure = 'refusal' | 'max_tokens' | 'no_text' | 'invalid_json' | 'schema';

/** The model answered, but not with usable output. Carries no model text, by design. */
export class LlmOutputError extends Error {
  override name = 'LlmOutputError';
  readonly failure: LlmOutputFailure;
  /** Total cost of every attempt, already recorded in usage. */
  readonly costPence: number;

  constructor(failure: LlmOutputFailure, costPence: number) {
    super(`LLM output unusable: ${failure}`);
    this.failure = failure;
    this.costPence = costPence;
  }
}

/**
 * Thrown before any API call when a funnel call's worst case doesn't fit what is left of the
 * run's lease (or its stage's share), or when S3 is paused near the monthly cap (ADR-032). The
 * funnel catches it and leaves the rest of the queue for the next run.
 */
export class RunBudgetExceededError extends Error {
  override name = 'RunBudgetExceededError';
  readonly reason: 'run_budget' | 'deep_pause';

  constructor(reason: 'run_budget' | 'deep_pause') {
    super(`Run budget: ${reason}`);
    this.reason = reason;
  }
}
