import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { SCAN, SHORT_LOCK } from '../config.js';
import { liveLockHolder, lockStaleMs } from './store.js';

const NOW = new Date('2026-10-07T09:00:00Z');
const MIN = 60_000;

/** A db whose `locks/scan` document holds `data`. */
function dbWith(data: Record<string, unknown> | undefined): Firestore {
  return { doc: () => ({ get: () => Promise.resolve({ data: () => data }) }) } as never;
}

/** The lock as `acquireLock` writes it: `staleAt` is the start plus the holder's window. */
function lockedAt(holder: 'scan' | 'email' | 'lookup' | 'wipe', startedMs: number) {
  const startedAt = new Date(NOW.getTime() - startedMs);
  return {
    runId: 'r1',
    holder,
    startedAt,
    staleAt: new Date(startedAt.getTime() + lockStaleMs(holder)),
    schemaVersion: 1,
  };
}

describe('lock staleness (ADR-048): a lock is live until its window ends, then free', () => {
  it('uses 12 / 3 / 2 / 3 minutes for scan / email / lookup / wipe', () => {
    expect(lockStaleMs('scan')).toBe(12 * MIN);
    expect(lockStaleMs('email')).toBe(3 * MIN);
    expect(lockStaleMs('lookup')).toBe(2 * MIN);
    expect(lockStaleMs('wipe')).toBe(3 * MIN);
    expect(SCAN.lockStaleMs).toBe(12 * MIN);
    expect(SHORT_LOCK.lookupStaleMs).toBe(2 * MIN);
  });

  it.each([
    ['scan', 12],
    ['email', 3],
    ['lookup', 2],
    ['wipe', 3],
  ] as const)(
    '%s: held 1 ms short of %i min is live, at the window it is free',
    async (holder, minutes) => {
      const window = minutes * MIN;
      expect(await liveLockHolder(dbWith(lockedAt(holder, window - 1)), NOW)).toBe(holder);
      expect(await liveLockHolder(dbWith(lockedAt(holder, window)), NOW)).toBeNull();
      expect(await liveLockHolder(dbWith(lockedAt(holder, window + 1)), NOW)).toBeNull();
    },
  );

  it('a lock written before M6 (no staleAt, no holder) goes stale at 12 minutes as a scan', async () => {
    const legacy = (ageMs: number) => ({
      runId: 'old',
      startedAt: new Date(NOW.getTime() - ageMs),
      schemaVersion: 1,
    });
    expect(await liveLockHolder(dbWith(legacy(12 * MIN - 1)), NOW)).toBe('scan');
    expect(await liveLockHolder(dbWith(legacy(12 * MIN)), NOW)).toBeNull();
  });

  it('a released or missing lock is free', async () => {
    expect(await liveLockHolder(dbWith(undefined), NOW)).toBeNull();
    expect(await liveLockHolder(dbWith({ lastFinishedAt: NOW, schemaVersion: 1 }), NOW)).toBeNull();
  });
});
