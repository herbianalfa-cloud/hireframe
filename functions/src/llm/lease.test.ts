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
});
