import { CALLABLE_TIMEOUT_SECONDS } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { LLM, MODELS, RUNTIME_SERVICE_ACCOUNT, type LlmPurpose } from './config.js';

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

describe('runtime service account', () => {
  it('is a full service-account email, not the `name@` shorthand', () => {
    expect(RUNTIME_SERVICE_ACCOUNT).toMatch(
      /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/,
    );
  });
});
