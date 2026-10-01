import { CALLABLE_TIMEOUT_SECONDS } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { LLM, MODELS, type LlmPurpose } from './config.js';

describe('time limits', () => {
  it.each(Object.keys(MODELS) as LlmPurpose[])(
    '%s: the llm.call() budget fits inside the callable timeout',
    (purpose) => {
      const model = MODELS[purpose];
      expect(model.budgetMs + LLM.callableMarginMs).toBeLessThanOrEqual(
        CALLABLE_TIMEOUT_SECONDS[purpose] * 1000,
      );
      expect(model.timeoutMs).toBeLessThanOrEqual(model.budgetMs - LLM.countTokensTimeoutMs);
    },
  );
});
