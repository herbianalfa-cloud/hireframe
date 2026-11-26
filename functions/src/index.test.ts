import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CALLABLE_TIMEOUT_SECONDS } from '@hireframe/shared';
import ts from 'typescript';
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
  serviceAccountEmail?: string;
  scheduleTrigger?: { retryConfig?: { retryCount?: number } };
  eventTrigger?: { eventType?: string; retry?: boolean };
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
    ['deleteAllData', []],
    ['scanNow', ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY', 'ANTHROPIC_API_KEY', 'REED_API_KEY']],
    ['scheduledScan', ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY', 'ANTHROPIC_API_KEY', 'REED_API_KEY']],
    ['rescore', ['ANTHROPIC_API_KEY', 'REED_API_KEY']],
    ['lookup', ['ANTHROPIC_API_KEY']],
    ['application', ['ANTHROPIC_API_KEY']],
    ['generateCvs', ['ANTHROPIC_API_KEY']],
    ['purgeOldData', []],
    ['billingGuard', []],
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

describe('deleteAllData (ADR-057)', () => {
  const endpoint = endpoints.find(([name]) => name === 'deleteAllData')?.[1];

  it('is an owner callable in europe-west2, 120 s, 512 MiB, one instance and one request', () => {
    expect(endpoint?.callableTrigger).toBeDefined();
    expect(endpoint?.region).toEqual(['europe-west2']);
    expect(endpoint?.timeoutSeconds).toBe(120);
    expect(endpoint?.availableMemoryMb).toBe(512);
    expect(endpoint?.maxInstances).toBe(1);
    expect(endpoint?.concurrency).toBe(1);
  });

  it('states its limits in its own options, and never calls itself', () => {
    const source = readFileSync(new URL('./wipe/callable.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/^\s*maxInstances: 1,$/m);
    expect(source).toMatch(/^\s*concurrency: 1,$/m);
    for (const file of ['./wipe/run.ts', './wipe/store.ts', './wipe/callable.ts']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(text, file).not.toMatch(/httpsCallable|setTimeout|enqueue|CloudTasks|PubSub/);
    }
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

describe('purgeOldData (ADR-057)', () => {
  const endpoint = (
    deployed.purgeOldData as unknown as {
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

  it('runs at 03:30 every day, UK time, without platform retries', () => {
    expect(endpoint?.scheduleTrigger).toMatchObject({
      schedule: '30 3 * * *',
      timeZone: 'Europe/London',
      retryConfig: { retryCount: 0 },
    });
  });

  it('states 300 s, 512 MiB and one instance', () => {
    expect(endpoint?.timeoutSeconds).toBe(300);
    expect(endpoint?.availableMemoryMb).toBe(512);
    expect(endpoint?.maxInstances).toBe(1);
  });

  it('is started by its schedule only', () => {
    expect(endpoint?.callableTrigger).toBeUndefined();
    expect(endpoint?.httpsTrigger).toBeUndefined();
    expect(endpoint?.eventTrigger).toBeUndefined();
  });

  it('states maxInstances and retryCount in its own options', () => {
    const source = readFileSync(new URL('./retention/schedule.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/^\s*maxInstances: 1,$/m);
    expect(source).toMatch(/^\s*retryCount: 0,$/m);
  });
});

describe('billingGuard (ADR-059)', () => {
  const endpoint = (
    deployed.billingGuard as unknown as {
      __endpoint?: {
        eventTrigger?: {
          eventType?: string;
          eventFilters?: Record<string, string>;
          retry?: boolean;
        };
        serviceAccountEmail?: string;
        timeoutSeconds?: number;
        availableMemoryMb?: number | string;
        maxInstances?: number | string;
        secretEnvironmentVariables?: unknown[];
        environmentVariables?: Record<string, string>;
        callableTrigger?: object;
        httpsTrigger?: object;
        scheduleTrigger?: object;
      };
    }
  ).__endpoint;

  it('is triggered by a Pub/Sub message on the billing-guard topic, with no retry', () => {
    expect(endpoint?.eventTrigger?.eventType).toBe('google.cloud.pubsub.topic.v1.messagePublished');
    expect(endpoint?.eventTrigger?.eventFilters).toEqual({ topic: 'billing-guard' });
    expect(endpoint?.eventTrigger?.retry).toBe(false);
  });

  // The manifest has one account; firebase-tools copies it to the Eventarc trigger too
  // (gcp/cloudfunctionsv2.js), and RUNBOOK check C14b reads both live.
  it('runs as hireframe-billing-guard, not the shared runtime account', () => {
    expect(endpoint?.serviceAccountEmail).toBe(
      'hireframe-billing-guard@hireframe-f6b03.iam.gserviceaccount.com',
    );
  });

  it('states 1 instance, 60 s from the shared table and 256 MiB', () => {
    expect(endpoint?.maxInstances).toBe(1);
    expect(endpoint?.timeoutSeconds).toBe(CALLABLE_TIMEOUT_SECONDS.billingGuard);
    expect(endpoint?.timeoutSeconds).toBe(60);
    expect(endpoint?.availableMemoryMb).toBe(256);
  });

  it('mounts no secrets and has no other trigger', () => {
    expect(endpoint?.secretEnvironmentVariables ?? []).toEqual([]);
    expect(endpoint?.callableTrigger).toBeUndefined();
    expect(endpoint?.httpsTrigger).toBeUndefined();
    expect(endpoint?.scheduleTrigger).toBeUndefined();
  });

  it('states maxInstances and retry in its own options, not only the global ones', () => {
    const source = readFileSync(new URL('./billing/endpoint.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/^\s*maxInstances: 1,$/m);
    expect(source).toMatch(/^\s*retry: false,$/m);
  });
});

type Trigger = 'callable' | 'https' | 'schedule' | 'pubsub';
type Account = 'fns' | 'guard';

// Every number is written out on purpose, as in the region test: a changed constant must fail
// here, not just follow itself. A new export without a row fails the first test below.
const EXPECTED: Record<
  string,
  { trigger: Trigger; timeoutSeconds: number; memoryMb: number; account: Account }
> = {
  addFact: { trigger: 'callable', timeoutSeconds: 120, memoryMb: 1024, account: 'fns' },
  application: { trigger: 'callable', timeoutSeconds: 120, memoryMb: 1024, account: 'fns' },
  billingGuard: { trigger: 'pubsub', timeoutSeconds: 60, memoryMb: 256, account: 'guard' },
  deleteAllData: { trigger: 'callable', timeoutSeconds: 120, memoryMb: 512, account: 'fns' },
  generateCvs: { trigger: 'schedule', timeoutSeconds: 540, memoryMb: 1024, account: 'fns' },
  getDigest: { trigger: 'https', timeoutSeconds: 60, memoryMb: 512, account: 'fns' },
  ingestEmailJobs: { trigger: 'https', timeoutSeconds: 120, memoryMb: 512, account: 'fns' },
  lookup: { trigger: 'callable', timeoutSeconds: 300, memoryMb: 1024, account: 'fns' },
  parseCv: { trigger: 'callable', timeoutSeconds: 540, memoryMb: 1024, account: 'fns' },
  purgeOldData: { trigger: 'schedule', timeoutSeconds: 300, memoryMb: 512, account: 'fns' },
  rescore: { trigger: 'callable', timeoutSeconds: 540, memoryMb: 1024, account: 'fns' },
  resetProfile: { trigger: 'callable', timeoutSeconds: 120, memoryMb: 1024, account: 'fns' },
  scanNow: { trigger: 'callable', timeoutSeconds: 540, memoryMb: 1024, account: 'fns' },
  scheduledScan: { trigger: 'schedule', timeoutSeconds: 540, memoryMb: 1024, account: 'fns' },
};

const ACCOUNTS: Record<Account, string> = {
  fns: 'hireframe-fns@hireframe-f6b03.iam.gserviceaccount.com',
  guard: 'hireframe-billing-guard@hireframe-f6b03.iam.gserviceaccount.com',
};

/**
 * Functions whose timeout reads another row of the shared table: the scheduled scan runs the same
 * scan as `scanNow` and has no row of its own.
 */
const TIMEOUT_KEY: Record<string, keyof typeof CALLABLE_TIMEOUT_SECONDS> = {
  scheduledScan: 'scanNow',
};

function timeoutKey(name: string): keyof typeof CALLABLE_TIMEOUT_SECONDS {
  return TIMEOUT_KEY[name] ?? (name as keyof typeof CALLABLE_TIMEOUT_SECONDS);
}

const PUBSUB_PUBLISHED = 'google.cloud.pubsub.topic.v1.messagePublished';

/** Problems with how the trigger calls in one source file state their limits; empty is clean. */
function limitProblems(file: string, source: string): { problems: string[]; calls: number } {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const triggerName = /^(on|before)[A-Z]/;
  // Local names bound to a trigger (aliases included) and local names of whole-module imports.
  const triggers = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const from = statement.moduleSpecifier;
    if (!ts.isStringLiteral(from) || !from.text.startsWith('firebase-functions')) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if (triggerName.test((element.propertyName ?? element.name).text)) {
        triggers.add(element.name.text);
      }
    }
  }
  const problems: string[] = [];
  let calls = 0;
  const calleeOf = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression))
      return triggers.has(expression.text) ? expression.text : undefined;
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      namespaces.has(expression.expression.text) &&
      triggerName.test(expression.name.text)
    ) {
      return `${expression.expression.text}.${expression.name.text}`;
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    const callee = ts.isCallExpression(node) ? calleeOf(node.expression) : undefined;
    if (ts.isCallExpression(node) && callee !== undefined) {
      calls += 1;
      let owner = '<anonymous>';
      for (let up: ts.Node = node.parent; !ts.isSourceFile(up); up = up.parent) {
        if (ts.isVariableDeclaration(up) && ts.isIdentifier(up.name)) {
          owner = up.name.text;
          break;
        }
      }
      const label = `${file}: ${owner} (${callee})`;
      const options = node.arguments[0];
      if (!options || !ts.isObjectLiteralExpression(options)) {
        problems.push(`${label}: options are not an object literal`);
      } else {
        const own = (key: string) =>
          options.properties.findIndex(
            (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === key,
          );
        const initializer = (key: string): ts.Expression | undefined => {
          const property = options.properties[own(key)];
          return property && ts.isPropertyAssignment(property) ? property.initializer : undefined;
        };
        const max = initializer('maxInstances');
        if (!max || !ts.isNumericLiteral(max) || max.text !== '1') {
          problems.push(`${label}: maxInstances is not the literal 1`);
        }
        const timeout = initializer('timeoutSeconds');
        const key = timeoutKey(owner);
        const fromTable =
          timeout !== undefined &&
          ts.isPropertyAccessExpression(timeout) &&
          ts.isIdentifier(timeout.expression) &&
          timeout.expression.text === 'CALLABLE_TIMEOUT_SECONDS' &&
          timeout.name.text === key;
        if (!timeout || !(ts.isNumericLiteral(timeout) || fromTable)) {
          problems.push(
            `${label}: timeoutSeconds is not a number or CALLABLE_TIMEOUT_SECONDS.${key}`,
          );
        }
        // A spread after either key can overwrite the literal the scan just read.
        const firstKey = Math.min(
          ...['maxInstances', 'timeoutSeconds'].map(own).filter((i) => i >= 0),
        );
        if (options.properties.some((p, i) => ts.isSpreadAssignment(p) && i > firstKey)) {
          problems.push(`${label}: a spread comes after maxInstances or timeoutSeconds`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { problems, calls };
}

/**
 * The scan over several sources, plus the count rule: a trigger the scan cannot see (re-exported
 * through a local module, built by a wrapper) leaves fewer call sites than exported functions.
 */
function scanProblems(sources: { file: string; source: string }[], exportCount: number): string[] {
  let calls = 0;
  const problems: string[] = [];
  for (const { file, source } of sources) {
    const found = limitProblems(file, source);
    calls += found.calls;
    problems.push(...found.problems);
  }
  if (calls !== exportCount) {
    problems.push(
      `${String(calls)} trigger calls found for ${String(exportCount)} exported functions`,
    );
  }
  return problems;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'loadtest' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Problems with the trigger an endpoint declares against the one its row expects; empty is clean. */
function triggerProblems(endpoint: Endpoint, want: Trigger): string[] {
  const set = {
    callable: endpoint.callableTrigger !== undefined,
    https: endpoint.httpsTrigger !== undefined,
    schedule: endpoint.scheduleTrigger !== undefined,
    // Any other event trigger (Firestore, Storage) must not pass as pubsub.
    pubsub: endpoint.eventTrigger?.eventType === PUBSUB_PUBLISHED,
  };
  const problems: string[] = [];
  const kinds = Object.entries(set)
    .filter(([, on]) => on)
    .map(([kind]) => kind);
  if (kinds.length !== 1 || kinds[0] !== want) {
    problems.push(`trigger is [${kinds.join(', ')}], expected ${want}`);
  }
  if (endpoint.eventTrigger !== undefined && want !== 'pubsub') {
    problems.push('has an event trigger but the row is not pubsub');
  }
  if (endpoint.eventTrigger === undefined && want === 'pubsub') {
    problems.push('has no event trigger');
  }
  if (want === 'schedule' && endpoint.scheduleTrigger?.retryConfig?.retryCount !== 0) {
    problems.push('scheduled retryCount is not 0');
  }
  if (want === 'pubsub' && endpoint.eventTrigger?.retry !== false) {
    problems.push('pubsub retry is not false');
  }
  return problems;
}

describe('every function states its limits (ADR-060, C2)', () => {
  it('exports exactly the functions in the table', () => {
    expect(Object.keys(deployed).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(Object.keys(EXPECTED)).toHaveLength(14);
  });

  it.each(endpoints)('%s states its limits and runs as the right account', (name, endpoint) => {
    const want = EXPECTED[name];
    expect(want).toBeDefined();
    if (!want || !endpoint) throw new Error(`${name}: no row or no endpoint`);
    expect(endpoint.maxInstances).toBe(1);
    expect(endpoint.timeoutSeconds).toBe(want.timeoutSeconds);
    expect(endpoint.timeoutSeconds).toBe(CALLABLE_TIMEOUT_SECONDS[timeoutKey(name)]);
    expect(endpoint.availableMemoryMb).toBe(want.memoryMb);

    expect(triggerProblems(endpoint, want.trigger)).toEqual([]);
    expect(endpoint.serviceAccountEmail).toBe(ACCOUNTS[want.account]);
  });

  it('every trigger call in the source states maxInstances: 1 and its timeout in its own options', () => {
    const root = fileURLToPath(new URL('.', import.meta.url));
    const sources = sourceFiles(root).map((path) => ({
      file: path.slice(root.length),
      source: readFileSync(path, 'utf8'),
    }));
    expect(scanProblems(sources, Object.keys(EXPECTED).length)).toEqual([]);
  });

  describe('the trigger check catches what it should', () => {
    it('passes a pubsub row with a pubsub event trigger', () => {
      const endpoint = { eventTrigger: { eventType: PUBSUB_PUBLISHED, retry: false } };
      expect(triggerProblems(endpoint as Endpoint, 'pubsub')).toEqual([]);
    });

    it('fails a Firestore event trigger on the pubsub row', () => {
      const endpoint = {
        eventTrigger: { eventType: 'google.cloud.firestore.document.v1.written', retry: false },
      };
      expect(triggerProblems(endpoint as Endpoint, 'pubsub')).not.toEqual([]);
    });

    it('fails a pubsub event trigger that retries', () => {
      const endpoint = { eventTrigger: { eventType: PUBSUB_PUBLISHED, retry: true } };
      expect(triggerProblems(endpoint as Endpoint, 'pubsub')).not.toEqual([]);
    });
  });

  describe('the source scan catches what it should', () => {
    const wrap = (options: string, name = 'thing') =>
      `import { onCall } from 'firebase-functions/https';\n` +
      `export const ${name} = onCall(${options}, async () => {});`;
    const ok = '{ maxInstances: 1, timeoutSeconds: 60 }';

    it('passes a complete call', () => {
      expect(limitProblems('a.ts', wrap(ok))).toEqual({ problems: [], calls: 1 });
      expect(
        limitProblems(
          'a.ts',
          wrap('{ maxInstances: 1, timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.lookup }', 'lookup'),
        ).problems,
      ).toEqual([]);
    });

    it.each([
      ['no maxInstances', '{ timeoutSeconds: 60 }'],
      ['maxInstances 2', '{ maxInstances: 2, timeoutSeconds: 60 }'],
      ['maxInstances from a constant', '{ maxInstances: ONE, timeoutSeconds: 60 }'],
      ['only a spread', '{ ...ownerOptions, timeoutSeconds: 60 }'],
      ['no timeout', '{ maxInstances: 1 }'],
      ['a timeout from a variable', '{ maxInstances: 1, timeoutSeconds: seconds }'],
      ['not an object literal', 'ownerOptions'],
    ])('flags %s', (_label, options) => {
      expect(limitProblems('a.ts', wrap(options)).problems).toHaveLength(1);
    });

    it('flags a table key that is not the function name', () => {
      const options = '{ maxInstances: 1, timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.scanNow }';
      expect(limitProblems('a.ts', wrap(options, 'lookup')).problems).toHaveLength(1);
    });

    it('names the wrapper that owns a trigger built inside it', () => {
      const source =
        `import { onCall } from 'firebase-functions/https';\n` +
        `export const make = () => onCall({}, async () => {});`;
      const found = limitProblems('a.ts', source);
      expect(found.calls).toBe(1);
      expect(found.problems.join()).toContain('make (onCall)');
    });

    it('flags a trigger with no owning variable as anonymous', () => {
      const source =
        `import { onCall } from 'firebase-functions/https';\n` +
        `export default onCall({}, async () => {});`;
      const found = limitProblems('a.ts', source);
      expect(found.calls).toBe(1);
      expect(found.problems.join()).toContain('<anonymous> (onCall)');
    });

    it('flags a spread placed after a key it could overwrite', () => {
      const options = '{ maxInstances: 1, timeoutSeconds: 60, ...wide }';
      expect(limitProblems('a.ts', wrap(options)).problems).toHaveLength(1);
    });

    it('sees an aliased import, a namespace import and a before* trigger', () => {
      const aliased =
        `import { onCall as call } from 'firebase-functions/https';\n` +
        `export const a = call({}, async () => {});`;
      const namespaced =
        `import * as https from 'firebase-functions/v2/https';\n` +
        `export const b = https.onCall({}, async () => {});`;
      const identity =
        `import { beforeUserCreated } from 'firebase-functions/identity';\n` +
        `export const c = beforeUserCreated({}, async () => {});`;
      for (const source of [aliased, namespaced, identity]) {
        const found = limitProblems('a.ts', source);
        expect(found.calls).toBe(1);
        expect(found.problems).not.toEqual([]);
      }
    });

    it('ignores a namespace call that is not a trigger', () => {
      const source =
        `import * as https from 'firebase-functions/v2/https';\n` +
        `export const b = https.HttpsError;`;
      expect(limitProblems('a.ts', source)).toEqual({ problems: [], calls: 0 });
    });

    it('the count rule flags a trigger re-exported through a local module', () => {
      const direct = { file: 'a.ts', source: wrap(ok, 'first') };
      const hidden = {
        file: 'b.ts',
        source: `import { onCall } from './wrapper.js';\nexport const second = onCall({});`,
      };
      expect(scanProblems([direct], 1)).toEqual([]);
      expect(scanProblems([direct, hidden], 2)).toEqual([
        '1 trigger calls found for 2 exported functions',
      ]);
    });

    it('ignores on*() calls that are not from firebase-functions', () => {
      const source = `import { onCall } from 'elsewhere';\nexport const x = onCall({});`;
      expect(limitProblems('a.ts', source)).toEqual({ problems: [], calls: 0 });
    });
  });
});
