import { readdirSync, readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLogSink } from '../log.js';
import { billingGuard } from './endpoint.js';

function cloudEvent(costAmount: number) {
  const message = {
    budgetDisplayName: 'hireframe-kill',
    costAmount,
    budgetAmount: 25,
    currencyCode: 'GBP',
    costIntervalStart: '2026-10-01T00:00:00Z',
  };
  return {
    specversion: '1.0',
    id: 'test-1',
    source: '//pubsub.googleapis.com/projects/demo/topics/billing-guard',
    type: 'google.cloud.pubsub.topic.v1.messagePublished',
    time: '2026-10-19T10:00:00Z',
    data: {
      subscription: 'projects/demo/subscriptions/x',
      message: {
        messageId: '1',
        publishTime: '2026-10-19T10:00:00Z',
        data: Buffer.from(JSON.stringify(message)).toString('base64'),
        attributes: {},
      },
    },
  };
}

/** The exported function itself, so the whole Pub/Sub wrapper runs (not just the raw handler). */
const invoke = billingGuard as unknown as (event: unknown) => Promise<unknown>;

describe('billingGuard wiring: the real wrapper in dry run (ADR-059)', () => {
  let logged: { event: string; fields: Record<string, unknown> }[] = [];
  const fetchSpy = vi.fn();

  beforeEach(() => {
    logged = [];
    setLogSink((_level, event, fields) => logged.push({ event, fields }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubEnv('BILLING_GUARD_MODE', '');
    delete process.env.BILLING_GUARD_MODE;
  });
  afterEach(() => {
    setLogSink();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fetchSpy.mockReset();
  });

  it('logs would_disable at the threshold with the variable unset, and never calls fetch', async () => {
    await invoke(cloudEvent(25));
    expect(logged.map((entry) => entry.event)).toEqual(['billing_guard.would_disable']);
    expect(logged[0]?.fields).toMatchObject({ mode: 'dry_run' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stays in dry run for anything but the exact string armed', async () => {
    for (const value of ['ARMED', ' armed', 'true']) {
      vi.stubEnv('BILLING_GUARD_MODE', value);
      await invoke(cloudEvent(99));
    }
    expect(logged.map((entry) => entry.event)).toEqual(
      Array(3).fill('billing_guard.would_disable'),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs below with dry_run under the threshold, and never calls fetch', async () => {
    await invoke(cloudEvent(1));
    expect(logged.map((entry) => entry.event)).toEqual(['billing_guard.below']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('billingGuard wiring: a message with no data', () => {
  it('logs invalid, resolves and makes no request', async () => {
    const logged: string[] = [];
    const fetchSpy = vi.fn();
    setLogSink((_level, event) => logged.push(event));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const event = cloudEvent(99);
      const attributesOnly = { ...event.data.message, data: undefined };
      await expect(
        invoke({ ...event, data: { ...event.data, message: attributesOnly } }),
      ).resolves.toBeUndefined();
      expect(logged).toEqual(['billing_guard.invalid']);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      setLogSink();
      vi.unstubAllGlobals();
    }
  });
});

/** Removes comments but not string contents: a `/*` inside a string is not a comment. */
function stripComments(source: string): string {
  let out = '';
  for (let i = 0; i < source.length;) {
    const char = source[i] ?? '';
    if (char === '"' || char === "'" || char === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== char) j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else {
      out += char;
      i++;
    }
  }
  return out;
}

const ALLOWED_IMPORTS = new Set([
  'zod',
  'node:timers/promises',
  'firebase-functions/pubsub',
  '@hireframe/shared',
  '../options.js',
  '../config.js',
  '../log.js',
  '../http/client.js',
  './client.js',
  './decide.js',
  './handler.js',
  './schema.js',
]);
const ALLOWED_URLS = new Set([
  'http://metadata.google.internal/computeMetadata/v1',
  'https://cloudbilling.googleapis.com/v1',
]);

const FORBIDDEN: [string, RegExp][] = [
  ['firebase-admin', /firebase-admin/i],
  ['Firestore', /getFirestore|Firestore|\bdb\(\)/i],
  ['Storage', /getStorage|\bStorage\b/i],
  ['publishing', /\bpublish(Message)?\(|\bPubSub\b|@google-cloud\/pubsub/],
  ['calling a callable', /httpsCallable/],
  ['Cloud Tasks', /CloudTasks|@google-cloud\/tasks|getFunctions|enqueue/],
  ['a timer re-run', /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/],
  ['a schedule', /onSchedule|onDocument|onObject|onCall|onRequest/],
  ['secrets', /defineSecret|secrets:/],
  ['a project override', /GCLOUD_PROJECT|GOOGLE_CLOUD_PROJECT|firebase-functions\/params/],
];

/** Everything a billing source file must not do; empty means clean. */
function violations(name: string, source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  for (const [what, pattern] of FORBIDDEN) if (pattern.test(code)) found.push(what);
  for (const match of code.matchAll(/(?:\bfrom\s+|\bimport\s+)['"]([^'"]+)['"]/g)) {
    if (!ALLOWED_IMPORTS.has(match[1] ?? '')) found.push(`import ${match[1] ?? ''}`);
  }
  if (/\bimport\s*\(|\brequire\s*\(/.test(code)) found.push('a dynamic import');
  for (const match of code.matchAll(/https?:\/\/[^\s'"`]+/g)) {
    if (!ALLOWED_URLS.has(match[0])) found.push(`url ${match[0]}`);
  }
  const fetches = code.match(/(?<![\w.])fetch\(|\.fetch\(/g) ?? [];
  const allowedFetch = name === 'endpoint.ts' ? 1 : 0;
  if (fetches.length > allowedFetch || (allowedFetch && !code.includes('globalThis.fetch('))) {
    found.push('a direct fetch');
  }
  return found;
}

describe('billing source guard: no way to trigger or re-run itself (CLAUDE.md hard rule)', () => {
  const dir = new URL('./', import.meta.url);
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'testing.ts')
    .map((name) => [name, readFileSync(new URL(name, dir), 'utf8')] as const);

  it('checks the files it means to check', () => {
    expect(sources.map(([name]) => name).sort()).toEqual([
      'client.ts',
      'decide.ts',
      'endpoint.ts',
      'handler.ts',
      'schema.ts',
    ]);
  });

  it.each(sources)('%s has none of the forbidden calls, imports or URLs', (name, source) => {
    expect(violations(name, source)).toEqual([]);
  });

  it('never names a project literal or an override: the target comes from the metadata server only', () => {
    for (const [name, source] of sources) {
      expect(source, name).not.toMatch(/hireframe-f6b03/);
    }
  });

  it.each([
    ['an import from outside billing', "import { x } from '../scan/store.js';"],
    ['a lower-case firestore import', "import { y } from '@google-cloud/firestore';"],
    ['a dynamic import', "const m = await import('../scan/store.js');"],
    [
      'REST to Pub/Sub',
      "await fetch('https://pubsub.googleapis.com/v1/projects/p/topics/t:publish');",
    ],
    ['a fetch to the function itself', "await globalThis.fetch('https://x.run.app/');"],
    ['publishMessage', 'await topic.publishMessage({ data });'],
    ['code hidden after /* in a string', "const a = '/*'; topic.publish(x); const b = '*/';"],
    ['a project override', 'const p = process.env.GCLOUD_PROJECT;'],
  ])('the guard itself catches %s', (_label, snippet) => {
    expect(violations('client.ts', snippet).length).toBeGreaterThan(0);
  });
});
