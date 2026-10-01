import { CRITERIA_SEED_V1 } from '@hireframe/shared';

import { hostPolicy, SCAN } from '../config.js';
import { createHttpClient, type HttpClient, type HttpClientDeps } from '../http/client.js';
import { fakeFetch } from './fake-fetch.js';
import { FAKE_WATCHLIST } from './fixtures.js';
import type { SourceContext } from './types.js';

/** A client on a fake clock (sleeps advance it instantly) for tests. */
export function testHttpClient(overrides: Partial<HttpClientDeps> = {}): HttpClient {
  let clock = Date.parse('2026-10-01T08:00:00Z');
  return createHttpClient({
    fetch: fakeFetch as typeof fetch,
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    random: () => 0,
    userAgent: SCAN.userAgent,
    productToken: SCAN.productToken,
    hostPolicy,
    maxAttempts: SCAN.maxAttempts,
    backoffBaseMs: SCAN.backoffBaseMs,
    retryAfterCapMs: SCAN.retryAfterCapMs,
    maxBodyBytes: SCAN.maxBodyBytes,
    log: () => undefined,
    ...overrides,
  });
}

export function testContext(overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    http: testHttpClient(),
    companies: FAKE_WATCHLIST,
    criteria: CRITERIA_SEED_V1,
    now: new Date('2026-10-01T08:00:00Z'),
    secrets: { reedApiKey: 'fake-reed', adzunaAppId: 'fake-id', adzunaAppKey: 'fake-key' },
    callBudget: 5,
    queryCursor: 0,
    ...overrides,
  };
}
