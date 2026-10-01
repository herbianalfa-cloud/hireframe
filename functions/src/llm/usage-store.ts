import {
  checkCap,
  PATHS,
  staleReservationIds,
  UNSETTLED_PURPOSE,
  UsageSchema,
  type TokenCounts,
  type Usage,
} from '@hireframe/shared';
import type { Firestore } from 'firebase-admin/firestore';

import { timestampsToDates } from '../timestamps.js';
import { SpendCapExceededError } from './errors.js';

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
}

export interface SettleInput {
  month: string;
  id: string;
  now: Date;
  model: string;
  purpose: string;
  tokens: TokenCounts;
  costPence: number;
}

export interface UsageStore {
  /** Throws SpendCapExceededError, writing nothing, when the reservation doesn't fit. */
  reserve(input: ReserveInput): Promise<void>;
  /** Releases this call's reservation, charges stale ones and records the actual cost. */
  settle(input: SettleInput): Promise<void>;
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
  return {
    ...current,
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
    updatedAt: input.now,
  };
}

/** Parses a usage document; a corrupt one throws, so nothing is spent until it's fixed. */
function readUsage(data: unknown, capPence: number, now: Date): Usage {
  return data === undefined
    ? emptyUsage(capPence, now)
    : UsageSchema.parse(timestampsToDates(data));
}

export function firestoreUsageStore(firestore: Firestore): UsageStore {
  return {
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
