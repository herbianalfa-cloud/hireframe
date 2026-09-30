import { z } from 'zod';

/**
 * Spend accounting for `llm.call()` (PRD R11, ADR-016). `usage/{yyyy-mm}` holds the month's
 * spend in pence plus live reservations: a call reserves its worst-case cost before it runs, so
 * concurrent calls can never overshoot the cap. Reservations older than the TTL are ignored by
 * the cap check and pruned when a call settles, so a crashed call can't block spending.
 */

export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const RESERVATION_TTL_MS = 15 * 60 * 1000;

const PENCE_DECIMALS = 10_000;

/** Rounds up to 1/10000 of a penny, so tiny calls still count and totals never under-report. */
function roundUpPence(pence: number): number {
  return Math.ceil(pence * PENCE_DECIMALS - 1e-9) / PENCE_DECIMALS;
}

function usdToPence(usd: number, fxUsdToGbp: number): number {
  return roundUpPence(usd * fxUsdToGbp * 100);
}

export function costPence(tokens: TokenCounts, price: ModelPrice, fxUsdToGbp: number): number {
  const usd =
    (tokens.input * price.inputUsdPerMTok +
      tokens.output * price.outputUsdPerMTok +
      tokens.cacheRead * price.cacheReadUsdPerMTok +
      tokens.cacheWrite * price.cacheWriteUsdPerMTok) /
    1_000_000;
  return usdToPence(usd, fxUsdToGbp);
}

/** Most a call can cost: every input token at the uncached rate plus `maxTokens` of output. */
export function worstCasePence(
  inputTokens: number,
  maxTokens: number,
  price: ModelPrice,
  fxUsdToGbp: number,
): number {
  return costPence(
    { input: inputTokens, output: maxTokens, cacheRead: 0, cacheWrite: 0 },
    price,
    fxUsdToGbp,
  );
}

/** `YYYY-MM` for `date` in Europe/London, the key of `usage/{yyyy-mm}`. */
export function monthKey(date: Date, timeZone = 'Europe/London'): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit' })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.year ?? ''}-${parts.month ?? ''}`;
}

export const ReservationSchema = z.object({ pence: z.number().min(0), at: z.date() });
export type Reservation = z.infer<typeof ReservationSchema>;

export function isLive(reservation: Reservation, now: Date, ttlMs = RESERVATION_TTL_MS): boolean {
  return now.getTime() - reservation.at.getTime() < ttlMs;
}

export function liveReservedPence(
  reservations: Readonly<Record<string, Reservation>>,
  now: Date,
  ttlMs = RESERVATION_TTL_MS,
): number {
  return Object.values(reservations)
    .filter((reservation) => isLive(reservation, now, ttlMs))
    .reduce((sum, reservation) => sum + reservation.pence, 0);
}

export interface CapCheck {
  ok: boolean;
  /** Pence still available after spend and live reservations. */
  availablePence: number;
}

export function checkCap(input: {
  spendPence: number;
  reservations: Readonly<Record<string, Reservation>>;
  capPence: number;
  requestPence: number;
  now: Date;
  ttlMs?: number;
}): CapCheck {
  const available =
    input.capPence -
    input.spendPence -
    liveReservedPence(input.reservations, input.now, input.ttlMs ?? RESERVATION_TTL_MS);
  return { ok: input.requestPence <= available, availablePence: Math.max(0, available) };
}

/** IDs to delete when settling: this call's reservation plus every stale one. */
export function reservationsToRemove(
  reservations: Readonly<Record<string, Reservation>>,
  ownId: string,
  now: Date,
  ttlMs = RESERVATION_TTL_MS,
): string[] {
  return Object.entries(reservations)
    .filter(([id, reservation]) => id === ownId || !isLive(reservation, now, ttlMs))
    .map(([id]) => id);
}

const TokenCountsSchema = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  cacheRead: z.number().min(0),
  cacheWrite: z.number().min(0),
});

export const UsageSchema = z.object({
  spendPence: z.number().min(0),
  capPence: z.number().min(0),
  reservations: z.record(z.string(), ReservationSchema),
  calls: z.record(z.string(), z.number().min(0)),
  tokens: z.record(z.string(), TokenCountsSchema),
  byPurpose: z.record(z.string(), z.number().min(0)),
  createdAt: z.date(),
  updatedAt: z.date(),
  schemaVersion: z.literal(1),
});
export type Usage = z.infer<typeof UsageSchema>;
