import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLogSink } from '../log.js';
import { createBillingClient, type BillingClient } from './client.js';
import { runGuard, type GuardDeps } from './handler.js';
import { fakeGoogle, okRoutes, PROJECT, timeoutError, TOKEN } from './testing.js';

const MARKER = 'SECRET-MARKER-TEXT';

function data(overrides: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      budgetDisplayName: 'hireframe-kill',
      costAmount: 30,
      budgetAmount: 25,
      currencyCode: 'GBP',
      costIntervalStart: '2026-10-01T00:00:00Z',
      ...overrides,
    }),
  ).toString('base64');
}

let logged: { level: string; event: string; fields: Record<string, unknown> }[] = [];

beforeEach(() => {
  logged = [];
  setLogSink((level, event, fields) => logged.push({ level, event, fields }));
});
afterEach(() => {
  setLogSink();
});

function events(): string[] {
  return logged.map((entry) => entry.event);
}

function armedWith(routes: ReturnType<typeof okRoutes>) {
  const g = fakeGoogle(routes);
  const deps: GuardDeps = { mode: 'armed', billing: () => createBillingClient(g.deps) };
  return { g, deps };
}

describe('runGuard: dry run', () => {
  it.each([25, 30, 9999])(
    'makes no network call at cost %s, and says would_disable',
    async (cost) => {
      const g = fakeGoogle(okRoutes(true));
      const billing = vi.fn(() => createBillingClient(g.deps));
      await runGuard(data({ costAmount: cost }), { mode: 'dry_run', billing });
      expect(billing).not.toHaveBeenCalled();
      expect(g.calls).toHaveLength(0);
      expect(events()).toEqual(['billing_guard.would_disable']);
      expect(logged[0]?.fields).toMatchObject({ mode: 'dry_run', cost, budget: 25 });
    },
  );

  it('makes no network call below the threshold either', async () => {
    const g = fakeGoogle(okRoutes(true));
    await runGuard(data({ costAmount: 1 }), {
      mode: 'dry_run',
      billing: () => createBillingClient(g.deps),
    });
    expect(g.calls).toHaveLength(0);
    expect(events()).toEqual(['billing_guard.below']);
  });
});

describe('runGuard: decisions that need no network, armed or not', () => {
  it('ignores another budget or currency', async () => {
    const { g, deps } = armedWith(okRoutes(true));
    await runGuard(data({ budgetDisplayName: 'hireframe-5' }), deps);
    await runGuard(data({ currencyCode: 'USD' }), deps);
    expect(events()).toEqual(['billing_guard.ignored', 'billing_guard.ignored']);
    expect(logged.map((entry) => entry.fields.reason)).toEqual(['wrong_budget', 'wrong_currency']);
    expect(g.calls).toHaveLength(0);
  });

  it('logs invalid for garbage and for missing fields, with no network call', async () => {
    const { g, deps } = armedWith(okRoutes(true));
    await runGuard('%%%', deps);
    await runGuard(Buffer.from('{"costAmount":99}').toString('base64'), deps);
    expect(events()).toEqual(['billing_guard.invalid', 'billing_guard.invalid']);
    expect(g.calls).toHaveLength(0);
  });

  it('does nothing below the threshold when armed', async () => {
    const { g, deps } = armedWith(okRoutes(true));
    await runGuard(data({ costAmount: 24.99 }), deps);
    expect(events()).toEqual(['billing_guard.below']);
    expect(g.calls).toHaveLength(0);
  });
});

describe('runGuard: armed', () => {
  it('PUTs exactly once, on the project the metadata server reported', async () => {
    const { g, deps } = armedWith(okRoutes(true));
    await runGuard(data(), deps);
    expect(g.puts()).toHaveLength(1);
    expect(g.puts()[0]?.url).toContain(`/projects/${PROJECT}/billingInfo`);
    expect(g.puts()[0]?.body).toBe('{"billingAccountName":""}');
    expect(events()).toEqual(['billing_guard.disabled']);
  });

  it('does not PUT when billing is already off', async () => {
    const { g, deps } = armedWith(okRoutes(false));
    await runGuard(data(), deps);
    expect(g.puts()).toHaveLength(0);
    expect(events()).toEqual(['billing_guard.already_disabled']);
  });

  it('uses only the injected client, so no project literal can be touched', async () => {
    const billingEnabled = vi.fn(() => Promise.resolve(true));
    const disableBilling = vi.fn(() => Promise.resolve({ stillEnabled: false }));
    const client: BillingClient = {
      projectId: () => Promise.resolve('some-other-proj'),
      billingEnabled,
      disableBilling,
    };
    await runGuard(data(), { mode: 'armed', billing: () => client });
    expect(billingEnabled).toHaveBeenCalledWith('some-other-proj');
    expect(disableBilling).toHaveBeenCalledTimes(1);
    expect(disableBilling).toHaveBeenCalledWith('some-other-proj');
  });

  it('logs failed with code permission_denied on a 403', async () => {
    const routes = okRoutes(true);
    routes[`PUT cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`] = new Response(
      '{"error":{"message":"nope"}}',
      { status: 403 },
    );
    const { g, deps } = armedWith(routes);
    await runGuard(data(), deps);
    expect(events()).toEqual(['billing_guard.failed']);
    expect(logged[0]?.fields).toMatchObject({
      step: 'disable',
      code: 'permission_denied',
      status: 403,
    });
    expect(g.puts()).toHaveLength(1);
  });

  it('retries a 5xx 3 times, then logs failed', async () => {
    const routes = okRoutes(true);
    routes[`PUT cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`] = new Response(
      '',
      {
        status: 502,
      },
    );
    const { g, deps } = armedWith(routes);
    await runGuard(data(), deps);
    expect(g.puts()).toHaveLength(3);
    expect(events()).toEqual(['billing_guard.failed']);
    expect(logged[0]?.fields).toMatchObject({ code: 'http_status', status: 502, step: 'disable' });
  });

  it('logs failed with code timeout after 3 timed-out reads', async () => {
    const routes = okRoutes(true);
    routes[`GET cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`] = timeoutError();
    const { g, deps } = armedWith(routes);
    await runGuard(data(), deps);
    expect(logged.at(-1)?.fields).toMatchObject({ step: 'read', code: 'timeout' });
    expect(g.puts()).toHaveLength(0);
  });

  it('logs failed with code deadline when the metadata server used up the run (fake clock)', async () => {
    const routes = okRoutes(true);
    const g = fakeGoogle(routes);
    const slow = g.deps.fetch;
    g.deps.fetch = ((input: URL | string, init?: RequestInit) => {
      g.advance(46_000);
      return slow(input, init);
    }) as typeof fetch;
    await runGuard(data(), { mode: 'armed', billing: () => createBillingClient(g.deps) });
    expect(logged.at(-1)?.fields).toMatchObject({ step: 'read', code: 'deadline' });
    expect(g.puts()).toHaveLength(0);
  });

  it('logs failed when the PUT answer still shows billing enabled', async () => {
    const routes = okRoutes(true);
    routes[`PUT cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`] = new Response(
      JSON.stringify({ name: 'x', billingEnabled: true }),
    );
    const { deps } = armedWith(routes);
    await runGuard(data(), deps);
    expect(logged.at(-1)).toMatchObject({
      event: 'billing_guard.failed',
      fields: { code: 'still_enabled' },
    });
  });

  it('never throws, even for a surprise error', async () => {
    const client: BillingClient = {
      projectId: () => Promise.reject(new Error(`boom ${MARKER}`)),
      billingEnabled: vi.fn(),
      disableBilling: vi.fn(),
    };
    await expect(
      runGuard(data(), { mode: 'armed', billing: () => client }),
    ).resolves.toBeUndefined();
    expect(logged.at(-1)?.fields).toMatchObject({ step: 'project', code: 'unexpected' });
  });
});

describe('runGuard: logs carry no message text', () => {
  it('logs codes and amounts only, in every outcome', async () => {
    const extra = { note: MARKER, budgetDisplayName: 'hireframe-kill' };
    const failing = okRoutes(true);
    failing[`PUT cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`] = new Response(
      `${MARKER} ${TOKEN}`,
      { status: 403 },
    );
    const runs = [
      armedWith(okRoutes(true)).deps,
      armedWith(okRoutes(false)).deps,
      armedWith(failing).deps,
      { mode: 'dry_run' as const, billing: () => createBillingClient(fakeGoogle({}).deps) },
    ];
    for (const deps of runs) {
      await runGuard(data(extra), deps);
      await runGuard(data({ ...extra, costAmount: 1 }), deps);
      await runGuard(data({ ...extra, currencyCode: 'USD' }), deps);
      await runGuard(Buffer.from(`not json ${MARKER}`).toString('base64'), deps);
    }
    const everything = JSON.stringify(logged);
    expect(logged.length).toBeGreaterThan(8);
    expect(everything).not.toContain(MARKER);
    expect(everything).not.toContain('hireframe-kill');
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('2026-10-01');
  });
});
