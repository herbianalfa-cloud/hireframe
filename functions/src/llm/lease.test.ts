import { describe, expect, it } from 'vitest';

import { RunBudgetExceededError } from './errors.js';
import { createRunLease } from './lease.js';
import type { ReserveInput, SettleInput } from './usage-store.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const reserve = (id: string, pence: number): ReserveInput => ({
  month: '2026-10',
  id,
  pence,
  capPence: 0,
  now: NOW,
});
const settle = (id: string, costPence: number, purpose = 'triage'): SettleInput => ({
  month: '2026-10',
  id,
  now: NOW,
  model: 'claude-haiku-4-5',
  purpose,
  tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
  costPence,
});

describe('createRunLease', () => {
  it('counts in-flight worst cases, so actual spend never passes the lease', async () => {
    const lease = createRunLease({ grantedPence: 10, s2Share: 1, deepAllowed: true });
    const s3 = lease.usage('s3');
    await s3.reserve(reserve('a', 6));
    await expect(s3.reserve(reserve('b', 5))).rejects.toThrow(RunBudgetExceededError);
    await s3.settle(settle('a', 1.5, 'deepRead'));
    // Only the actual 1.5p counts once settled.
    await expect(s3.reserve(reserve('b', 8))).resolves.toBeUndefined();
    expect(lease.usedPence()).toBe(1.5);
  });

  it('keeps S2 within its share of the lease', async () => {
    const lease = createRunLease({ grantedPence: 10, s2Share: 0.4, deepAllowed: true });
    await lease.usage('s2').reserve(reserve('a', 3));
    const error: unknown = await lease
      .usage('s2')
      .reserve(reserve('b', 2))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunBudgetExceededError);
    expect((error as RunBudgetExceededError).reason).toBe('run_budget');
    // S3 can still use the rest.
    await expect(lease.usage('s3').reserve(reserve('c', 6))).resolves.toBeUndefined();
  });

  it('refuses every S3 call during a deep pause', async () => {
    const lease = createRunLease({ grantedPence: 10, s2Share: 0.4, deepAllowed: false });
    const error: unknown = await lease
      .usage('s3')
      .reserve(reserve('a', 0.1))
      .catch((e: unknown) => e);
    expect((error as RunBudgetExceededError).reason).toBe('deep_pause');
    await expect(lease.usage('s2').reserve(reserve('b', 1))).resolves.toBeUndefined();
  });

  it('refuses everything with a zero lease', async () => {
    const lease = createRunLease({ grantedPence: 0, s2Share: 0.4, deepAllowed: true });
    await expect(lease.usage('s2').reserve(reserve('a', 0.01))).rejects.toThrow(
      RunBudgetExceededError,
    );
  });

  it('aggregates calls, tokens and spend per purpose for one settlement', async () => {
    const lease = createRunLease({ grantedPence: 10, s2Share: 0.4, deepAllowed: true });
    const s2 = lease.usage('s2');
    for (const id of ['a', 'b']) {
      await s2.reserve(reserve(id, 0.5));
      await s2.settle(settle(id, 0.15));
    }
    expect(lease.usedPence('s2')).toBe(0.3);
    expect(lease.usedPence('s3')).toBe(0);
    expect(lease.settlement()).toEqual({
      costPence: 0.3,
      calls: { 'claude-haiku-4-5': 2 },
      tokens: { 'claude-haiku-4-5': { input: 2_000, output: 200, cacheRead: 0, cacheWrite: 0 } },
      byPurpose: { triage: 0.3 },
    });
  });

  describe('back-pressure', () => {
    it('tracks the largest reservation and the calls in flight per stage', async () => {
      const lease = createRunLease({ grantedPence: 10, s2Share: 0.5, deepAllowed: true });
      expect(lease.maxReserved('s2')).toBe(0);
      await lease.usage('s2').reserve(reserve('a', 0.4));
      await lease.usage('s2').reserve(reserve('b', 0.6));
      await lease.usage('s2').settle(settle('a', 0.1));
      await lease.usage('s2').reserve(reserve('c', 0.5));
      expect(lease.maxReserved('s2')).toBe(0.6);
      expect(lease.maxReserved('s3')).toBe(0);
      expect(lease.inFlight('s2')).toBe(2);
      expect(lease.inFlight('s3')).toBe(0);
      expect(lease.inFlight()).toBe(2);
    });

    it('does not count a refused reservation as reserved', async () => {
      const lease = createRunLease({ grantedPence: 1, s2Share: 1, deepAllowed: true });
      await lease
        .usage('s3')
        .reserve(reserve('a', 0.6))
        .catch(() => undefined);
      await lease
        .usage('s3')
        .reserve(reserve('b', 0.6))
        .catch(() => undefined);
      expect(lease.maxReserved('s3')).toBe(0.6);
      expect(lease.inFlight()).toBe(1);
    });

    it('lets a stage with no history start', async () => {
      const lease = createRunLease({ grantedPence: 10, s2Share: 0.4, deepAllowed: true });
      await expect(lease.waitForRoom('s2')).resolves.toBe(true);
    });

    it('waits for an in-flight call to settle, then reports room', async () => {
      const lease = createRunLease({ grantedPence: 1, s2Share: 1, deepAllowed: true });
      const s2 = lease.usage('s2');
      await s2.reserve(reserve('a', 0.6));
      let resolved: boolean | undefined;
      const waiting = lease.waitForRoom('s2').then((room) => (resolved = room));
      await Promise.resolve();
      expect(resolved).toBeUndefined();
      await s2.settle(settle('a', 0.15));
      await waiting;
      expect(resolved).toBe(true);
    });

    it('reports no room when the next call cannot fit and nothing is in flight', async () => {
      const lease = createRunLease({ grantedPence: 1, s2Share: 1, deepAllowed: true });
      const s2 = lease.usage('s2');
      await s2.reserve(reserve('a', 0.6));
      await s2.settle(settle('a', 0.6));
      await expect(lease.waitForRoom('s2')).resolves.toBe(false);
    });

    it('keeps waiting through several settles until the worst case fits', async () => {
      const lease = createRunLease({ grantedPence: 1.2, s2Share: 1, deepAllowed: true });
      const s2 = lease.usage('s2');
      for (const id of ['a', 'b']) await s2.reserve(reserve(id, 0.5));
      let resolved: boolean | undefined;
      const waiting = lease.waitForRoom('s2').then((room) => (resolved = room));
      await s2.settle(settle('a', 0.1));
      await Promise.resolve();
      // 0.5 in flight + 0.1 used + 0.5 next fits in 1.2: room after the first settle.
      await waiting;
      expect(resolved).toBe(true);
    });

    it('resolves nextSettle at once when nothing is in flight', async () => {
      const lease = createRunLease({ grantedPence: 1, s2Share: 1, deepAllowed: true });
      await expect(lease.nextSettle()).resolves.toBeUndefined();
    });

    it('wakes every waiter on a settle', async () => {
      const lease = createRunLease({ grantedPence: 1, s2Share: 1, deepAllowed: true });
      const s2 = lease.usage('s2');
      await s2.reserve(reserve('a', 0.9));
      const woken: number[] = [];
      const waiters = [1, 2].map((n) => lease.nextSettle().then(() => woken.push(n)));
      await s2.settle(settle('a', 0.1));
      await Promise.all(waiters);
      expect(woken).toEqual([1, 2]);
    });
  });
});
