import { CALLABLE_TIMEOUT_SECONDS } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import {
  API_TERMS_HOSTS,
  hostPolicy,
  LLM,
  MODELS,
  RUNTIME_SERVICE_ACCOUNT,
  type LlmPurpose,
} from './config.js';

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

describe('source host policies (ADR-025, ADR-027)', () => {
  it('spaces Workable to one request every 5 s on the host it is called on', () => {
    expect(hostPolicy('apply.workable.com').intervalMs).toBeGreaterThanOrEqual(5_000);
  });

  it('keeps every other host at 1 request/s or slower, and robots.txt on unless keyed', () => {
    expect(hostPolicy('boards-api.greenhouse.io')).toMatchObject({
      robots: 'enforce',
      intervalMs: 1_000,
    });
    expect(hostPolicy('api.adzuna.com').intervalMs).toBe(3_000);
    expect([...API_TERMS_HOSTS].sort()).toEqual(['api.adzuna.com', 'www.reed.co.uk']);
  });
});
