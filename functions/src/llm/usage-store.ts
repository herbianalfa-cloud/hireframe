import {
  addDailySpend,
  checkCap,
  checkDailyCap,
  DAILY_CAP_KEYS,
  dailyReservationPrefix,
  dayKey,
  liveReservedPence,
  PATHS,
  staleReservationIds,
  UNSETTLED_PURPOSE,
  UsageSchema,
  type TokenCounts,
  type Usage,
} from '@hireframe/shared';
import type { Firestore } from 'firebase-admin/firestore';

import { timestampsToDates } from '../timestamps.js';
import { DailyCapExceededError, SpendCapExceededError } from './errors.js';

/**
 * `usage/{yyyy-mm}` reservations and settlement (ADR-016). Both run in Firestore transactions,
 * so concurrent calls see each other's reservations and can never overshoot the cap together.
 */
export interface ReserveInput {
  month: string;
  id: string;
  pence: number;
  capPence: number;
  now: Date;
  /** Also check the purpose's daily cap in the same transaction (ADR-047). */
  daily?: { key: string; capPence: number };
}

export interface SettleInput {
  month: string;
  id: string;
  now: Date;
  model: string;
  purpose: string;
  tokens: TokenCounts;
  costPence: number;
  /** Add the actual cost to this purpose's daily total (ADR-047). */
  dailyKey?: string;
}

export interface UsageStore {
  /** Throws SpendCapExceededError, writing nothing, when the reservation doesn't fit. */
  reserve(input: ReserveInput): Promise<void>;
  /** Releases this call's reservation, charges stale ones and records the actual cost. */
  settle(input: SettleInput): Promise<void>;
}

// ---- Run leases (ADR-032) ----

export interface LeaseInput {
  month: string;
  id: string;
  /** The most this run may spend. */
  maxPence: number;
  capPence: number;
  now: Date;
}

export interface LeaseGrant {
  /** Pence reserved for the run (0 when the month has nothing left). */
  grantedPence: number;
  /** The month's spend plus everyone else's live reservations, before this lease. */
  committedPence: number;
  capPence: number;
}

/** What a run spent, aggregated in memory and settled in one transaction. */
export interface LeaseSettlement {
  costPence: number;
  calls: Record<string, number>;
  tokens: Record<string, TokenCounts>;
  byPurpose: Record<string, number>;
}

export interface LeaseStore {
  /** Reserves up to `maxPence` of what the month has left, in one transaction. */
  reserveUpTo(input: LeaseInput): Promise<LeaseGrant>;
  /** Releases the lease and records what the run spent, in one transaction. */
  settleLease(input: {
    month: string;
    id: string;
    now: Date;
    settlement: LeaseSettlement;
  }): Promise<void>;
}

export function emptyUsage(capPence: number, now: Date): Usage {
  return {
    spendPence: 0,
    capPence,
    reservations: {},
    calls: {},
    tokens: {},
    byPurpose: {},
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
}

export function applyReserve(current: Usage, input: ReserveInput): Usage {
  const base = chargeStale(current, input.now);
  const check = checkCap({
    spendPence: base.spendPence,
    reservations: base.reservations,
    capPence: input.capPence,
    requestPence: input.pence,
    now: input.now,
  });
  if (!check.ok) throw new SpendCapExceededError();
  if (input.daily) {
    const day = checkDailyCap({
      daily: base.daily,
      key: input.daily.key,
      reservations: base.reservations,
      capPence: input.daily.capPence,
      requestPence: input.pence,
      now: input.now,
    });
    if (!day.ok) throw new DailyCapExceededError();
  }
  return {
    ...base,
    capPence: input.capPence,
    reservations: { ...base.reservations, [input.id]: { pence: input.pence, at: input.now } },
    updatedAt: input.now,
  };
}

function round(pence: number): number {
  return Math.round(pence * 10_000) / 10_000;
}

function without(
  reservations: Usage['reservations'],
  ids: readonly string[],
): Usage['reservations'] {
  const drop = new Set(ids);
  return Object.fromEntries(Object.entries(reservations).filter(([id]) => !drop.has(id)));
}

/**
 * Charges every stale reservation (except `ownId`) as spent at its worst case (ADR-016). A call
 * that never settled was killed mid-flight and may have been billed. Deliberately fails safe:
 * a crash can overstate the month's spend, never understate it.
 */
export function chargeStale(current: Usage, now: Date, ownId?: string): Usage {
  const stale = staleReservationIds(current.reservations, now, ownId);
  if (stale.length === 0) return current;
  const pence = stale.reduce((sum, id) => sum + (current.reservations[id]?.pence ?? 0), 0);
  // A stale reservation of a daily-capped purpose counts against today too (ADR-047).
  let daily = current.daily;
  for (const key of DAILY_CAP_KEYS) {
    const mine = stale
      .filter((id) => id.startsWith(dailyReservationPrefix(key)))
      .reduce((sum, id) => sum + (current.reservations[id]?.pence ?? 0), 0);
    if (mine > 0) daily = addDailySpend(daily, key, dayKey(now), round(mine));
  }
  return {
    ...current,
    ...(daily ? { daily } : {}),
    reservations: without(current.reservations, stale),
    spendPence: round(current.spendPence + pence),
    byPurpose: {
      ...current.byPurpose,
      [UNSETTLED_PURPOSE]: round((current.byPurpose[UNSETTLED_PURPOSE] ?? 0) + pence),
    },
  };
}

export function applySettle(previous: Usage, input: SettleInput): Usage {
  const current = chargeStale(previous, input.now, input.id);
  const reservations = without(current.reservations, [input.id]);
  const tokens = current.tokens[input.model] ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  return {
    ...current,
    reservations,
    spendPence: round(current.spendPence + input.costPence),
    calls: { ...current.calls, [input.model]: (current.calls[input.model] ?? 0) + 1 },
    tokens: {
      ...current.tokens,
      [input.model]: {
        input: tokens.input + input.tokens.input,
        output: tokens.output + input.tokens.output,
        cacheRead: tokens.cacheRead + input.tokens.cacheRead,
        cacheWrite: tokens.cacheWrite + input.tokens.cacheWrite,
      },
    },
    byPurpose: {
      ...current.byPurpose,
      [input.purpose]: round((current.byPurpose[input.purpose] ?? 0) + input.costPence),
    },
    ...(input.dailyKey
      ? { daily: addDailySpend(current.daily, input.dailyKey, dayKey(input.now), input.costPence) }
      : {}),
    updatedAt: input.now,
  };
}

/**
 * A `UsageStore` that also holds `key` to a daily cap, checked in the same reserve transaction as
 * the month's (ADR-047). Reservation IDs must start `<key>-` so the day's live reservations can be
 * told apart; `llmCall` takes them from its `newId`.
 */
export function dailyCapped(store: UsageStore, key: string, dailyCapPence: number): UsageStore {
  const prefix = dailyReservationPrefix(key);
  const checked = (id: string) => {
    if (!id.startsWith(prefix)) throw new Error(`daily-capped reservations must start ${prefix}`);
  };
  return {
    reserve(input) {
      checked(input.id);
      return store.reserve({ ...input, daily: { key, capPence: dailyCapPence } });
    },
    settle(input) {
      checked(input.id);
      return store.settle({ ...input, dailyKey: key });
    },
  };
}

export function applyReserveUpTo(
  current: Usage,
  input: LeaseInput,
): { usage: Usage; grant: LeaseGrant } {
  const base = chargeStale(current, input.now);
  const committed = round(base.spendPence + liveReservedPence(base.reservations, input.now));
  const granted = round(Math.max(0, Math.min(input.maxPence, input.capPence - committed)));
  const grant = { grantedPence: granted, committedPence: committed, capPence: input.capPence };
  if (granted <= 0) return { usage: base, grant };
  return {
    usage: {
      ...base,
      capPence: input.capPence,
      reservations: { ...base.reservations, [input.id]: { pence: granted, at: input.now } },
      updatedAt: input.now,
    },
    grant,
  };
}

function addCounts(
  into: Record<string, number>,
  from: Readonly<Record<string, number>>,
): Record<string, number> {
  const out = { ...into };
  for (const [key, value] of Object.entries(from)) out[key] = round((out[key] ?? 0) + value);
  return out;
}

export function applySettleLease(
  previous: Usage,
  input: { id: string; now: Date; settlement: LeaseSettlement },
): Usage {
  const current = chargeStale(previous, input.now, input.id);
  const tokens = { ...current.tokens };
  for (const [model, counts] of Object.entries(input.settlement.tokens)) {
    const was = tokens[model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    tokens[model] = {
      input: was.input + counts.input,
      output: was.output + counts.output,
      cacheRead: was.cacheRead + counts.cacheRead,
      cacheWrite: was.cacheWrite + counts.cacheWrite,
    };
  }
  return {
    ...current,
    reservations: without(current.reservations, [input.id]),
    spendPence: round(current.spendPence + input.settlement.costPence),
    calls: addCounts(current.calls, input.settlement.calls),
    tokens,
    byPurpose: addCounts(current.byPurpose, input.settlement.byPurpose),
    updatedAt: input.now,
  };
}

/** Parses a usage document; a corrupt one throws, so nothing is spent until it's fixed. */
function readUsage(data: unknown, capPence: number, now: Date): Usage {
  return data === undefined
    ? emptyUsage(capPence, now)
    : UsageSchema.parse(timestampsToDates(data));
}

export function firestoreUsageStore(firestore: Firestore): UsageStore & LeaseStore {
  return {
    async reserveUpTo(input) {
      const ref = firestore.doc(PATHS.usage(input.month));
      return firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const { usage, grant } = applyReserveUpTo(
          readUsage(snapshot.data(), input.capPence, input.now),
          input,
        );
        tx.set(ref, usage);
        return grant;
      });
    },

    async settleLease(input) {
      const ref = firestore.doc(PATHS.usage(input.month));
      await firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        tx.set(ref, applySettleLease(readUsage(snapshot.data(), 0, input.now), input));
      });
    },

    async reserve(input) {
      const ref = firestore.doc(PATHS.usage(input.month));
      await firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const next = applyReserve(readUsage(snapshot.data(), input.capPence, input.now), input);
        tx.set(ref, next); // Dates are stored as Timestamps.
      });
    },

    async settle(input) {
      const ref = firestore.doc(PATHS.usage(input.month));
      await firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const current = readUsage(snapshot.data(), 0, input.now);
        tx.set(ref, applySettle(current, input));
      });
    },
  };
}
