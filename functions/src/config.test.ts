import { CALLABLE_TIMEOUT_SECONDS, DEFAULT_MONTHLY_CAP_PENCE } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import {
  API_TERMS_HOSTS,
  ApplicationOverridesSchema,
  APPLICATIONS,
  defaultRunBudgetPence,
  ALERT_LINK_HOSTS,
  ALERTS,
  FUNNEL,
  funnelLimits,
  HMAC,
  hostPolicy,
  LLM,
  MODELS,
  PURPOSE_CALLABLE,
  RUNTIME_SERVICE_ACCOUNT,
  SCAN,
  SHORT_LOCK,
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

describe('CV worker budgets (M7, ADR-053)', () => {
  const workerMs = CALLABLE_TIMEOUT_SECONDS.generateCvs * 1000;

  it('runs the worker for 540 s and writes CVs with Sonnet 5.5 at medium effort', () => {
    expect(workerMs).toBe(540_000);
    expect(PURPOSE_CALLABLE.cvWrite).toBe('generateCvs');
    expect(MODELS.cvWrite).toEqual({
      id: 'claude-sonnet-5-5',
      effort: 'medium',
      maxTokens: 8_000,
      timeoutMs: 150_000,
      budgetMs: 300_000,
    });
  });

  it('rule 1: one call (its retry included) plus the margin fits the worker timeout', () => {
    expect(MODELS.cvWrite.budgetMs + LLM.callableMarginMs).toBeLessThanOrEqual(workerMs);
  });

  it('rule 2: a call started at the start deadline still settles before the worker is killed', () => {
    expect(
      APPLICATIONS.workerStartDeadlineMs + MODELS.cvWrite.budgetMs + LLM.callableMarginMs,
    ).toBeLessThanOrEqual(workerMs);
    // The deadline is the latest one that fits: raising it by a second would break rule 2.
    expect(
      APPLICATIONS.workerStartDeadlineMs + 1_000 + MODELS.cvWrite.budgetMs + LLM.callableMarginMs,
    ).toBeGreaterThan(workerMs);
  });

  it('answers turn into facts under the application callable timeout', () => {
    expect(PURPOSE_CALLABLE.answerFact).toBe('application');
    expect(CALLABLE_TIMEOUT_SECONDS.application).toBe(120);
    expect(MODELS.answerFact.id).toBe(MODELS.addFact.id);
  });

  it('bounds the worker and the daily spend', () => {
    expect(APPLICATIONS).toMatchObject({
      dailyCapPence: 60,
      maxQuestions: 5,
      maxAttempts: 2,
      workerMaxPerRun: 10,
    });
    expect(ApplicationOverridesSchema.safeParse({ dailyCapPence: 80 }).success).toBe(true);
    expect(ApplicationOverridesSchema.safeParse({ dailyCapPence: -1 }).success).toBe(false);
    expect(ApplicationOverridesSchema.safeParse({}).success).toBe(true);
  });
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

describe('Gmail bridge limits (ADR-046, ADR-047, ADR-048)', () => {
  it('keeps a nonce at least twice as long as the allowed skew, so a replay is always caught', () => {
    expect(HMAC.nonceTtlSeconds).toBeGreaterThanOrEqual(2 * HMAC.maxSkewSeconds);
    expect(HMAC.maxSkewSeconds).toBe(300);
    expect(HMAC.nonceTtlSeconds).toBe(600);
  });

  it('answers the script inside its 60 s UrlFetchApp limit: last call start plus its budget is 50 s at most', () => {
    expect(ALERTS.modelWindowMs + MODELS.alertParse.budgetMs).toBeLessThanOrEqual(50_000);
    expect(ALERTS.modelWindowMs).toBe(15_000);
    // The function's own timeout still covers the whole request.
    expect(ALERTS.modelWindowMs + MODELS.alertParse.budgetMs).toBeLessThanOrEqual(
      CALLABLE_TIMEOUT_SECONDS.ingestEmailJobs * 1000,
    );
    expect(CALLABLE_TIMEOUT_SECONDS.ingestEmailJobs).toBe(120);
    expect(ALERTS.maxBodyBytes).toBe(1_000_000);
    expect(ALERTS.maxMessagesPerRequest).toBe(5);
  });

  it('holds an ingest lock for its timeout plus a margin, and a scheduled scan waits 4 min in 15 s steps', () => {
    expect(SHORT_LOCK.emailStaleMs).toBeGreaterThan(
      CALLABLE_TIMEOUT_SECONDS.ingestEmailJobs * 1000,
    );
    expect(SHORT_LOCK.emailStaleMs).toBe(3 * 60_000);
    expect(SHORT_LOCK.emailStaleMs).toBeLessThan(SCAN.lockStaleMs);
    expect(SHORT_LOCK.scheduledWaitIntervalMs).toBe(15_000);
    expect(SHORT_LOCK.scheduledWaitMaxMs).toBe(4 * 60_000);
  });

  it('caps alert parsing at 10p a day by default, which is about 30 emails', () => {
    expect(ALERTS.dailyCapPence).toBe(10);
  });

  it('lists only the ATS hosts and the alert boards as trusted link hosts', () => {
    expect([...ALERT_LINK_HOSTS].sort()).toEqual(
      [
        'adzuna.co.uk',
        'ashbyhq.com',
        'escapethecity.org',
        'greenhouse.io',
        'indeed.co.uk',
        'indeed.com',
        'lever.co',
        'linkedin.com',
        'reed.co.uk',
        'welcometothejungle.com',
        'wellfound.com',
        'workable.com',
        'workatastartup.com',
      ].sort(),
    );
  });
});
