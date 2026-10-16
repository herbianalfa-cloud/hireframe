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

interface Runnable {
  run: (event: unknown) => Promise<unknown>;
}

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
    await (billingGuard as unknown as Runnable).run(cloudEvent(25));
    expect(logged.map((entry) => entry.event)).toEqual(['billing_guard.would_disable']);
    expect(logged[0]?.fields).toMatchObject({ mode: 'dry_run' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stays in dry run for anything but the exact string armed', async () => {
    for (const value of ['ARMED', ' armed', 'true']) {
      vi.stubEnv('BILLING_GUARD_MODE', value);
      await (billingGuard as unknown as Runnable).run(cloudEvent(99));
    }
    expect(logged.map((entry) => entry.event)).toEqual(
      Array(3).fill('billing_guard.would_disable'),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs below with dry_run under the threshold, and never calls fetch', async () => {
    await (billingGuard as unknown as Runnable).run(cloudEvent(1));
    expect(logged.map((entry) => entry.event)).toEqual(['billing_guard.below']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

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

  const forbidden: [string, RegExp][] = [
    ['firebase-admin', /firebase-admin/],
    ['Firestore', /getFirestore|Firestore|\bdb\(\)/],
    ['Storage', /getStorage|\bStorage\b/],
    ['publishing', /\.publish\(|\bPubSub\b|@google-cloud\/pubsub/],
    ['calling a callable', /httpsCallable/],
    ['Cloud Tasks', /CloudTasks|@google-cloud\/tasks|getFunctions|enqueue/],
    ['a timer re-run', /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/],
    ['a schedule', /onSchedule|onDocument|onObject|onCall|onRequest/],
    ['secrets', /defineSecret|secrets:/],
  ];

  it.each(sources)('%s has none of the forbidden calls', (_name, source) => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [what, pattern] of forbidden) {
      expect(pattern.test(code), what).toBe(false);
    }
  });

  it('never names a project literal: the target comes from the metadata server only', () => {
    for (const [name, source] of sources) {
      if (name === 'endpoint.ts' || name === 'client.ts' || name === 'decide.ts') continue;
      expect(source, name).not.toMatch(/hireframe-f6b03/);
    }
    const client = sources.find(([name]) => name === 'client.ts')?.[1] ?? '';
    expect(client).not.toMatch(/hireframe-f6b03/);
  });
});
