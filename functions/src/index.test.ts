import { CALLABLE_TIMEOUT_SECONDS } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import * as deployed from './index.js';

/** What firebase-functions hands the deploy tooling for each exported function. */
interface Endpoint {
  region?: string[];
  timeoutSeconds?: number;
  callableTrigger?: object;
}

const endpoints = Object.entries(deployed).map(
  ([name, fn]) => [name, (fn as { __endpoint?: Endpoint }).__endpoint] as const,
);

describe('deployed functions (ADR-017)', () => {
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
});
