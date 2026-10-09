import { z } from 'zod';

/**
 * Spend accounting for `llm.call()` (PRD R11, ADR-016). `usage/{yyyy-mm}` holds the month's
 * spend in pence plus live reservations: a call reserves its worst-case cost before it runs, so
 * concurrent calls can never overshoot the cap. A reservation older than the TTL belongs to a
 * call that never settled (killed mid-flight, e.g. at the callable timeout): the next reserve or
 * settle charges it as spent at its worst case, because the call may have been billed.
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

/** PRD R11 default monthly cap (£15); `config/app.monthlyCapPence` overrides it. */
export const DEFAULT_MONTHLY_CAP_PENCE = 1500;

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

/**
 * Most a call can cost: every input token at the uncached rate plus `maxTokens` of output. With
 * `cacheWrite` (a cached system prompt) input is reserved at the dearer of the uncached and the
 * 5-minute cache-write rate, since a cache write costs more than plain input.
 */
export function worstCasePence(
  inputTokens: number,
  maxTokens: number,
  price: ModelPrice,
  fxUsdToGbp: number,
  options: { cacheWrite?: boolean } = {},
): number {
  const inputRate = options.cacheWrite
    ? Math.max(price.inputUsdPerMTok, price.cacheWriteUsdPerMTok)
    : price.inputUsdPerMTok;
  return costPence(
    { input: inputTokens, output: maxTokens, cacheRead: 0, cacheWrite: 0 },
    { ...price, inputUsdPerMTok: inputRate },
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

/** `byPurpose` key for stale reservations charged at their worst case. */
export const UNSETTLED_PURPOSE = 'unsettled';

/** IDs of reservations whose calls never settled, except `ownId` (the call settling now). */
export function staleReservationIds(
  reservations: Readonly<Record<string, Reservation>>,
  now: Date,
  ownId?: string,
  ttlMs = RESERVATION_TTL_MS,
): string[] {
  return Object.entries(reservations)
    .filter(([id, reservation]) => id !== ownId && !isLive(reservation, now, ttlMs))
    .map(([id]) => id);
}

// ---- Daily caps (M6, ADR-047) ----

/** Purposes with their own daily cap besides the monthly one: `alertParse`, `lookup` and `application` (M7: CV writing and answers). */
export const DAILY_CAP_KEYS = ['alertParse', 'lookup', 'application'] as const;
export type DailyCapKey = (typeof DAILY_CAP_KEYS)[number];

/** A reservation belongs to a daily-capped purpose when its ID starts with `<key>-`. */
export function dailyReservationPrefix(key: string): string {
  return `${key}-`;
}

/** `YYYY-MM-DD` for `date` in Europe/London: the day a daily cap counts in. */
export function dayKey(date: Date, timeZone = 'Europe/London'): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}`;
}

export const DailySpendSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  spendPence: z.number().min(0),
});
export type DailySpend = z.infer<typeof DailySpendSchema>;
export type DailyUsage = Readonly<Record<string, DailySpend>>;

/** Pence settled today for `key`; a record from an earlier day counts as nothing. */
export function dailySpentPence(daily: DailyUsage | undefined, key: string, today: string): number {
  const entry = daily?.[key];
  return entry?.day === today ? entry.spendPence : 0;
}

/** `pence` added to today's total for `key`, starting a new day's total when the day changed. */
export function addDailySpend(
  daily: DailyUsage | undefined,
  key: string,
  today: string,
  pence: number,
): Record<string, DailySpend> {
  return {
    ...daily,
    [key]: { day: today, spendPence: dailySpentPence(daily, key, today) + pence },
  };
}

/**
 * Whether a call fits under the daily cap for `key`: today's settled spend, plus the live
 * reservations of that purpose (IDs starting `<key>-`), plus this call (ADR-047).
 */
export function checkDailyCap(input: {
  daily: DailyUsage | undefined;
  key: string;
  reservations: Readonly<Record<string, Reservation>>;
  capPence: number;
  requestPence: number;
  now: Date;
  ttlMs?: number;
}): CapCheck {
  const prefix = dailyReservationPrefix(input.key);
  const live = Object.fromEntries(
    Object.entries(input.reservations).filter(([id]) => id.startsWith(prefix)),
  );
  return checkCap({
    spendPence: dailySpentPence(input.daily, input.key, dayKey(input.now)),
    reservations: live,
    capPence: input.capPence,
    requestPence: input.requestPence,
    now: input.now,
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  });
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
  /** Today's settled spend per daily-capped purpose. Optional, so older documents still parse. */
  daily: z.record(z.string(), DailySpendSchema).exactOptional(),
  createdAt: z.date(),
  updatedAt: z.date(),
  schemaVersion: z.literal(1),
});
export type Usage = z.infer<typeof UsageSchema>;
