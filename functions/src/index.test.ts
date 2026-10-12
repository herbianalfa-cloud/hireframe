import { readFileSync } from 'node:fs';

import { CALLABLE_TIMEOUT_SECONDS } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import * as deployed from './index.js';

/** What firebase-functions hands the deploy tooling for each exported function. */
interface Endpoint {
  region?: string[];
  timeoutSeconds?: number;
  callableTrigger?: object;
  secretEnvironmentVariables?: { key: string }[];
  httpsTrigger?: object;
  availableMemoryMb?: number | string;
  maxInstances?: number | string;
  concurrency?: number | string;
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
    ['lookup', ['ANTHROPIC_API_KEY']],
    ['application', ['ANTHROPIC_API_KEY']],
    ['generateCvs', ['ANTHROPIC_API_KEY']],
    ['ingestEmailJobs', ['ANTHROPIC_API_KEY', 'INGEST_HMAC_SECRET']],
    ['getDigest', ['INGEST_HMAC_SECRET']],
  ])('%s mounts %j', (name, secrets) => {
    const endpoint = endpoints.find(([exported]) => exported === name)?.[1];
    expect(endpoint).toBeDefined();
    const mounted = (endpoint?.secretEnvironmentVariables ?? []).map((secret) => secret.key);
    expect(mounted.sort()).toEqual(secrets);
  });
});

describe('generateCvs (ADR-053)', () => {
  const endpoint = (
    deployed.generateCvs as unknown as {
      __endpoint?: {
        scheduleTrigger?: {
          schedule?: string;
          timeZone?: string;
          retryConfig?: { retryCount?: number };
        };
        timeoutSeconds?: number;
        availableMemoryMb?: number | string;
        maxInstances?: number | string;
        callableTrigger?: object;
        httpsTrigger?: object;
        eventTrigger?: object;
      };
    }
  ).__endpoint;

  it('runs every 10 minutes from 07:00 to 23:50, UK time, without platform retries', () => {
    expect(endpoint?.scheduleTrigger).toMatchObject({
      schedule: '*/10 7-23 * * *',
      timeZone: 'Europe/London',
      retryConfig: { retryCount: 0 },
    });
  });

  it('states the 540 s timeout from the shared table, 1 GiB and one instance', () => {
    expect(endpoint?.timeoutSeconds).toBe(CALLABLE_TIMEOUT_SECONDS.generateCvs);
    expect(endpoint?.timeoutSeconds).toBe(540);
    expect(endpoint?.availableMemoryMb).toBe(1024);
    expect(endpoint?.maxInstances).toBe(1);
  });

  it('is started by its schedule only: no HTTPS, callable or event trigger', () => {
    expect(endpoint?.callableTrigger).toBeUndefined();
    expect(endpoint?.httpsTrigger).toBeUndefined();
    expect(endpoint?.eventTrigger).toBeUndefined();
  });

  it('states maxInstances in its own options, not only the global ones', () => {
    const source = readFileSync(new URL('./applications/schedule.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/^\s*maxInstances: 1,$/m);
    expect(source).toMatch(/^\s*retryCount: 0,$/m);
  });

  // A fast source guard before any build. The bundle itself (the static import graph of
  // index.js and every chunk loading) is checked by scripts/smoke-functions-bundle.ts.
  it('does not import the renderer statically, so other functions never load it', () => {
    for (const file of ['./applications/schedule.ts', './applications/worker.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/^import\s+(?!type)[^;]*cv\/render/m);
    }
    const wiring = readFileSync(
      new URL('./applications/worker-wiring.ts', import.meta.url),
      'utf8',
    );
    expect(wiring).toMatch(/import\('\.\.\/cv\/render\/index\.js'\)/);
  });
});

describe('ingestEmailJobs (ADR-046)', () => {
  const endpoint = endpoints.find(([name]) => name === 'ingestEmailJobs')?.[1];

  it('is an HTTPS function, not a callable, with the shared 120 s timeout', () => {
    expect(endpoint?.httpsTrigger).toBeDefined();
    expect(endpoint?.callableTrigger).toBeUndefined();
    expect(endpoint?.timeoutSeconds).toBe(CALLABLE_TIMEOUT_SECONDS.ingestEmailJobs);
    expect(endpoint?.timeoutSeconds).toBe(120);
  });

  it('states one instance and one request at a time, so ingests never run in parallel', () => {
    expect(endpoint?.maxInstances).toBe(1);
    // 2nd gen defaults to 80 concurrent requests per instance: one instance alone isn't enough.
    expect(endpoint?.concurrency).toBe(1);
  });
});

describe('getDigest (ADR-052)', () => {
  const endpoint = endpoints.find(([name]) => name === 'getDigest')?.[1];

  it('is an HTTPS function with the shared 60 s timeout and no callable trigger', () => {
    expect(endpoint?.httpsTrigger).toBeDefined();
    expect(endpoint?.callableTrigger).toBeUndefined();
    expect(endpoint?.timeoutSeconds).toBe(CALLABLE_TIMEOUT_SECONDS.getDigest);
    expect(endpoint?.timeoutSeconds).toBe(60);
  });

  it('states 512 MiB, one instance and one request at a time', () => {
    expect(endpoint?.availableMemoryMb).toBe(512);
    expect(endpoint?.maxInstances).toBe(1);
    expect(endpoint?.concurrency).toBe(1);
  });

  it('sets cors: false in its options (the manifest does not carry it, so the source is read)', () => {
    const source = readFileSync(new URL('./digest/endpoint.ts', import.meta.url), 'utf8');
    const options = /onRequest\(\s*\{([\s\S]*?)\},\s*async/.exec(source)?.[1] ?? '';
    expect(options).toMatch(/^\s*cors: false,$/m);
  });

  it('mounts the HMAC secret and nothing else, in particular no model key', () => {
    const mounted = (endpoint?.secretEnvironmentVariables ?? []).map((secret) => secret.key);
    expect(mounted).toEqual(['INGEST_HMAC_SECRET']);
  });

  it('is not scheduled and has no event trigger (no self-triggering code)', () => {
    expect(endpoint).not.toHaveProperty('scheduleTrigger');
    expect(endpoint).not.toHaveProperty('eventTrigger');
  });
});

describe('application (M7, ADR-055)', () => {
  const endpoint = endpoints.find(([name]) => name === 'application')?.[1];

  it('is a callable with the shared 120 s timeout', () => {
    expect(endpoint?.callableTrigger).toBeDefined();
    expect(endpoint?.timeoutSeconds).toBe(CALLABLE_TIMEOUT_SECONDS.application);
    expect(endpoint?.timeoutSeconds).toBe(120);
  });

  it('states one instance', () => {
    expect(endpoint?.maxInstances).toBe(1);
  });

  // App Check, the instance count and the owner check are asserted on the options `onCall`
  // receives, in applications/callable.test.ts: the deploy manifest doesn't carry App Check.

  it('is not scheduled and has no event trigger (no self-triggering code)', () => {
    expect(endpoint).not.toHaveProperty('scheduleTrigger');
    expect(endpoint).not.toHaveProperty('eventTrigger');
  });
});
