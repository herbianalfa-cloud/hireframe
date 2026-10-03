import { RESERVATION_TTL_MS } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { applyReserveUpTo, applySettleLease, emptyUsage } from './usage-store.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const lease = (maxPence: number, capPence = 1_500) => ({
  month: '2026-10',
  id: 'run-r1',
  maxPence,
  capPence,
  now: NOW,
});

describe('run leases on usage/{month} (ADR-032)', () => {
  it('reserves the run budget when the month has room', () => {
    const { usage, grant } = applyReserveUpTo(emptyUsage(1_500, NOW), lease(24));
    expect(grant).toEqual({ grantedPence: 24, committedPence: 0, capPence: 1_500 });
    expect(usage.reservations['run-r1']).toEqual({ pence: 24, at: NOW });
  });

  it('grants only what is left, and nothing at the cap', () => {
    const nearCap = { ...emptyUsage(1_500, NOW), spendPence: 1_490 };
    expect(applyReserveUpTo(nearCap, lease(24)).grant.grantedPence).toBe(10);
    const full = { ...emptyUsage(1_500, NOW), spendPence: 1_500 };
    const { usage, grant } = applyReserveUpTo(full, lease(24));
    expect(grant.grantedPence).toBe(0);
    expect(usage.reservations).toEqual({});
  });

  it('counts other live reservations as committed and charges stale ones', () => {
    const old = new Date(NOW.getTime() - RESERVATION_TTL_MS - 1);
    const current = {
      ...emptyUsage(1_500, NOW),
      spendPence: 100,
      reservations: { live: { pence: 50, at: NOW }, dead: { pence: 30, at: old } },
    };
    const { usage, grant } = applyReserveUpTo(current, lease(24));
    expect(grant.committedPence).toBe(180);
    expect(usage.spendPence).toBe(130);
    expect(usage.byPurpose.unsettled).toBe(30);
  });

  it('settles the lease with the actual spend and the aggregated counts', () => {
    const { usage } = applyReserveUpTo(
      {
        ...emptyUsage(1_500, NOW),
        calls: { 'claude-haiku-4-5': 3 },
        byPurpose: { triage: 0.5 },
      },
      lease(24),
    );
    const settled = applySettleLease(usage, {
      id: 'run-r1',
      now: NOW,
      settlement: {
        costPence: 7.25,
        calls: { 'claude-haiku-4-5': 2, 'claude-sonnet-5-5': 3 },
        tokens: { 'claude-sonnet-5-5': { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 } },
        byPurpose: { triage: 0.3, deepRead: 6.95 },
      },
    });
    expect(settled.reservations).toEqual({});
    expect(settled.spendPence).toBe(7.25);
    expect(settled.calls).toEqual({ 'claude-haiku-4-5': 5, 'claude-sonnet-5-5': 3 });
    expect(settled.tokens['claude-sonnet-5-5']).toEqual({
      input: 9,
      output: 8,
      cacheRead: 7,
      cacheWrite: 6,
    });
    expect(settled.byPurpose).toEqual({ triage: 0.8, deepRead: 6.95 });
  });
});
