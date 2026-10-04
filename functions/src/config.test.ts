import { CALLABLE_TIMEOUT_SECONDS, DEFAULT_MONTHLY_CAP_PENCE } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import {
  API_TERMS_HOSTS,
  defaultRunBudgetPence,
  FUNNEL,
  funnelLimits,
  hostPolicy,
  LLM,
  MODELS,
  PURPOSE_CALLABLE,
  RUNTIME_SERVICE_ACCOUNT,
  SCAN,
  type LlmPurpose,
} from './config.js';

describe('time limits', () => {
  it.each(Object.keys(MODELS) as LlmPurpose[])(
    '%s: the llm.call() budget fits inside the callable timeout',
    (purpose) => {
      const model = MODELS[purpose];
      expect(model.budgetMs + LLM.callableMarginMs).toBeLessThanOrEqual(
        CALLABLE_TIMEOUT_SECONDS[PURPOSE_CALLABLE[purpose]] * 1000,
      );
      expect(model.timeoutMs).toBeLessThanOrEqual(model.budgetMs - LLM.countTokensTimeoutMs);
    },
  );
});

describe('funnel deadlines (ADR-032)', () => {
  const callableMs = CALLABLE_TIMEOUT_SECONDS.scanNow * 1000;

  it('starts the funnel after the fetch budget and ends each stage before the callable', () => {
    expect(SCAN.fetchBudgetMs).toBeLessThan(FUNNEL.s2StopMs);
    expect(FUNNEL.s2StopMs + MODELS.triage.budgetMs).toBeLessThanOrEqual(FUNNEL.s3StopMs + 10_000);
    expect(FUNNEL.s3StopMs + MODELS.deepRead.budgetMs + LLM.callableMarginMs).toBeLessThanOrEqual(
      callableMs,
    );
  });

  it('re-score shares the scan timeout', () => {
    expect(CALLABLE_TIMEOUT_SECONDS.rescore).toBe(CALLABLE_TIMEOUT_SECONDS.scanNow);
  });
});

describe('run budget (ADR-032)', () => {
  it('fits every scheduled run in 75% of the monthly cap', () => {
    expect(defaultRunBudgetPence(DEFAULT_MONTHLY_CAP_PENCE)).toBe(24);
    expect(
      defaultRunBudgetPence(DEFAULT_MONTHLY_CAP_PENCE) * FUNNEL.scheduledRunsPerMonth,
    ).toBeLessThanOrEqual(DEFAULT_MONTHLY_CAP_PENCE * 0.75);
    expect(defaultRunBudgetPence(3000)).toBe(48);
  });

  it('applies console overrides over the defaults', () => {
    expect(funnelLimits(1500, { runBudgetPence: 30, s3MaxJobs: 10 })).toMatchObject({
      runBudgetPence: 30,
      s3MaxJobs: 10,
      s2MaxJobs: FUNNEL.s2MaxJobs,
    });
  });
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
