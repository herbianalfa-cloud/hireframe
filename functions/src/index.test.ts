import { CALLABLE_TIMEOUT_SECONDS } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import * as deployed from './index.js';

/** What firebase-functions hands the deploy tooling for each exported function. */
interface Endpoint {
  region?: string[];
  timeoutSeconds?: number;
  callableTrigger?: object;
  secretEnvironmentVariables?: { key: string }[];
}

const endpoints = Object.entries(deployed).map(
  ([name, fn]) => [name, (fn as { __endpoint?: Endpoint }).__endpoint] as const,
);

describe('deployed functions (ADR-017)', () => {
  it('schedules scans at 07:30 and 17:30 on weekdays, UK time (PRD R4)', () => {
    const endpoint = (
      deployed.scheduledScan as unknown as {
        __endpoint?: {
          scheduleTrigger?: {
            schedule?: string;
            timeZone?: string;
            retryConfig?: { retryCount?: number };
          };
        };
      }
    ).__endpoint;
    expect(endpoint?.scheduleTrigger).toMatchObject({
      schedule: '30 7,17 * * 1-5',
      timeZone: 'Europe/London',
    });
  });

  it('exports at least one function', () => {
    expect(endpoints.length).toBeGreaterThan(0);
  });

  // Literal on purpose: moving the functions out of London must fail here, not just follow a
  // changed constant.
  it.each(endpoints)('%s runs in europe-west2 only', (_name, endpoint) => {
    expect(endpoint?.region).toEqual(['europe-west2']);
  });

  it.each(endpoints.filter(([, endpoint]) => endpoint?.callableTrigger))(
    '%s uses the shared callable timeout the web client waits for',
    (name, endpoint) => {
      expect(Object.keys(CALLABLE_TIMEOUT_SECONDS)).toContain(name);
      expect(endpoint?.timeoutSeconds).toBe(
        CALLABLE_TIMEOUT_SECONDS[name as keyof typeof CALLABLE_TIMEOUT_SECONDS],
      );
    },
  );

  // Each function mounts only the secrets it needs (ADR-017, ADR-025).
  it.each([
    ['parseCv', ['ANTHROPIC_API_KEY']],
    ['addFact', ['ANTHROPIC_API_KEY']],
    ['resetProfile', []],
    ['scanNow', ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY', 'ANTHROPIC_API_KEY', 'REED_API_KEY']],
    ['scheduledScan', ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY', 'ANTHROPIC_API_KEY', 'REED_API_KEY']],
    ['rescore', ['ANTHROPIC_API_KEY', 'REED_API_KEY']],
  ])('%s mounts %j', (name, secrets) => {
    const endpoint = endpoints.find(([exported]) => exported === name)?.[1];
    expect(endpoint).toBeDefined();
    const mounted = (endpoint?.secretEnvironmentVariables ?? []).map((secret) => secret.key);
    expect(mounted.sort()).toEqual(secrets);
  });
});
