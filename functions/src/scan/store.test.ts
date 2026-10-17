import { readFileSync } from 'node:fs';

import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { SCAN, SHORT_LOCK } from '../config.js';
import { isLockLive, liveLockHolder, lockLiveUntil, lockStaleMs } from './store.js';

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

describe('lockLiveUntil and isLockLive: the one stale rule (ADR-048)', () => {
  const START = new Date('2026-10-07T08:00:00Z');
  const at = (ms: number) => new Date(START.getTime() + ms);

  it.each([
    ['scan', 12],
    ['email', 3],
    ['lookup', 2],
    ['wipe', 3],
  ] as const)(
    '%s: live 1 ms before %i min, free at the window and 1 ms after',
    (holder, minutes) => {
      const window = minutes * MIN;
      const lock = {
        runId: 'r1',
        startedAt: START,
        staleAt: new Date(START.getTime() + lockStaleMs(holder)),
      };
      expect(lockLiveUntil(lock)).toEqual(at(window));
      expect(isLockLive(lock, at(window - 1))).toBe(true);
      expect(isLockLive(lock, at(window))).toBe(false);
      expect(isLockLive(lock, at(window + 1))).toBe(false);
    },
  );

  it('a legacy lock (no staleAt, no holder) falls back to 12 minutes', () => {
    const lock = { runId: 'old', startedAt: START };
    expect(lockLiveUntil(lock)).toEqual(at(12 * MIN));
    expect(isLockLive(lock, at(12 * MIN - 1))).toBe(true);
    expect(isLockLive(lock, at(12 * MIN))).toBe(false);
    expect(isLockLive(lock, at(12 * MIN + 1))).toBe(false);
  });

  it('a staleAt shorter than the 12-minute fallback is honoured', () => {
    const lock = { runId: 'r1', startedAt: START, staleAt: at(MIN) };
    expect(lockLiveUntil(lock)).toEqual(at(MIN));
    expect(isLockLive(lock, at(MIN - 1))).toBe(true);
    expect(isLockLive(lock, at(MIN))).toBe(false);
  });

  it('no runId, or an empty one, is not live', () => {
    expect(lockLiveUntil({ startedAt: START })).toBeUndefined();
    expect(lockLiveUntil({ runId: '', startedAt: START })).toBeUndefined();
    expect(isLockLive({ startedAt: START }, at(1))).toBe(false);
    expect(isLockLive({ runId: '', startedAt: START }, at(1))).toBe(false);
  });

  it('no startedAt is not live, even with a future staleAt', () => {
    const lock = { runId: 'r1', staleAt: at(60 * MIN) };
    expect(lockLiveUntil(lock)).toBeUndefined();
    expect(isLockLive(lock, at(1))).toBe(false);
  });

  it('no lock at all is not live', () => {
    expect(lockLiveUntil(undefined)).toBeUndefined();
    expect(isLockLive(undefined, at(1))).toBe(false);
  });

  it('drift guard: the fallback is written once, and all three sites use isLockLive', () => {
    const source = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
    expect(source.match(/\+ SCAN\.lockStaleMs/g)).toHaveLength(1);
    const uses = source.split('isLockLive(').length - 1;
    // One definition plus at least three call sites.
    expect(uses).toBeGreaterThanOrEqual(4);
  });
});
