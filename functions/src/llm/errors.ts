/** Thrown before any API call when the call's worst case would exceed the monthly cap. */
export class SpendCapExceededError extends Error {
  override name = 'SpendCapExceededError';
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
