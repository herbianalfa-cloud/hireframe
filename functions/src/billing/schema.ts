import { z } from 'zod';

/**
 * The Cloud Billing budget notification (ADR-059). Only the fields the decision needs are
 * required; everything else Google adds passes through untouched. Amounts must be finite,
 * the cost not negative and the budget above zero (a zero budget would trip on any cost).
 */
export const BudgetMessageSchema = z
  .object({
    budgetDisplayName: z.string().min(1),
    costAmount: z.number().finite().nonnegative(),
    budgetAmount: z.number().finite().positive(),
    currencyCode: z.string().min(1),
    costIntervalStart: z.string().min(1),
    alertThresholdExceeded: z.number().finite().optional(),
    forecastThresholdExceeded: z.number().finite().optional(),
  })
  .passthrough();

export type BudgetMessage = z.infer<typeof BudgetMessageSchema>;

/** A budget message is a few hundred bytes; anything near this is not one. */
const MAX_MESSAGE_BYTES = 8_192;

/**
 * Decodes and validates `event.data.message.data`. Returns null for anything that is not a valid
 * budget message (bad base64, bad JSON, missing or wrong-typed fields); the caller logs a code,
 * never the message text.
 */
export function parseBudgetMessage(base64: string): BudgetMessage | null {
  if (base64.length > MAX_MESSAGE_BYTES * 2) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = BudgetMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
