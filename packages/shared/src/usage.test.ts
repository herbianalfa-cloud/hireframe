import { describe, expect, it } from 'vitest';

import {
  checkCap,
  costPence,
  liveReservedPence,
  monthKey,
  RESERVATION_TTL_MS,
  staleReservationIds,
  UsageSchema,
  worstCasePence,
  type ModelPrice,
} from './usage.js';

const PRICE: ModelPrice = {
  inputUsdPerMTok: 2,
  outputUsdPerMTok: 10,
  cacheReadUsdPerMTok: 0.2,
  cacheWriteUsdPerMTok: 2.5,
};
const FX = 0.8;
const NOW = new Date('2026-10-15T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe('costPence', () => {
  it('prices every token kind in USD, then converts to pence', () => {
    // 1M input ($2) + 100k output ($1) + 1M cache read ($0.20) + 0 = $3.20 → £2.56 → 256p
    expect(
      costPence(
        { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 0 },
        PRICE,
        FX,
      ),
    ).toBeCloseTo(256, 6);
  });

  it('rounds up so tiny calls never count as free', () => {
    expect(
      costPence({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, PRICE, FX),
    ).toBeGreaterThan(0);
  });

  it('prices the worst case as all input uncached plus max output', () => {
    // 10k input ($0.02) + 32k output ($0.32) = $0.34 → 27.2p
    expect(worstCasePence(10_000, 32_000, PRICE, FX)).toBeCloseTo(27.2, 6);
  });

  it('reserves input at the cache-write rate when the prompt is cached', () => {
    // 10k input at $2.50 ($0.025) + 32k output ($0.32) = $0.345 → 27.6p
    expect(worstCasePence(10_000, 32_000, PRICE, FX, { cacheWrite: true })).toBeCloseTo(27.6, 6);
  });

  it('never reserves cached input below the uncached rate', () => {
    const cheapWrite = { ...PRICE, cacheWriteUsdPerMTok: 1 };
    expect(worstCasePence(10_000, 0, cheapWrite, FX, { cacheWrite: true })).toBe(
      worstCasePence(10_000, 0, cheapWrite, FX),
    );
  });
});

describe('monthKey', () => {
  it('uses Europe/London, so 23:30 UTC on 31 Oct in BST is still October', () => {
    expect(monthKey(new Date('2026-10-01T00:30:00+01:00'))).toBe('2026-10');
    expect(monthKey(new Date('2026-09-30T23:30:00Z'))).toBe('2026-10');
    expect(monthKey(new Date('2026-12-31T23:30:00Z'))).toBe('2026-12');
  });
});

describe('reservations and the cap', () => {
  const reservations = {
    live: { pence: 100, at: minutesAgo(5) },
    stale: { pence: 900, at: minutesAgo(16) },
  };

  it('ignores stale reservations', () => {
    expect(liveReservedPence(reservations, NOW)).toBe(100);
  });

  it('allows a call that fits under the cap after spend and live reservations', () => {
    expect(
      checkCap({ spendPence: 1300, reservations, capPence: 1500, requestPence: 100, now: NOW }),
    ).toEqual({ ok: true, availablePence: 100 });
  });

  it('blocks a call that would exceed the cap, before it runs', () => {
    expect(
      checkCap({ spendPence: 1300, reservations, capPence: 1500, requestPence: 100.01, now: NOW })
        .ok,
    ).toBe(false);
    expect(
      checkCap({ spendPence: 1600, reservations: {}, capPence: 1500, requestPence: 0, now: NOW }),
    ).toEqual({
      ok: false,
      availablePence: 0,
    });
  });

  it('finds stale reservations, never the settling call itself', () => {
    const all = { ...reservations, own: { pence: 5, at: minutesAgo(20) } };
    expect(staleReservationIds(all, NOW, 'own')).toEqual(['stale']);
    expect(staleReservationIds(all, NOW).sort()).toEqual(['own', 'stale']);
    expect(staleReservationIds(all, NOW, 'own', RESERVATION_TTL_MS * 10)).toEqual([]);
  });
});

describe('UsageSchema', () => {
  it('parses a usage document', () => {
    const doc = {
      spendPence: 12.5,
      capPence: 1500,
      reservations: { r1: { pence: 3, at: NOW } },
      calls: { 'claude-sonnet-5-5': 1 },
      tokens: { 'claude-sonnet-5-5': { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } },
      byPurpose: { parseCv: 12.5 },
      createdAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
    };
    expect(UsageSchema.parse(doc)).toEqual(doc);
    expect(UsageSchema.safeParse({ ...doc, spendPence: -1 }).success).toBe(false);
  });
});
