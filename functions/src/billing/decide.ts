import { BILLING_GUARD, type GuardMode } from '../config.js';
import type { BudgetMessage } from './schema.js';

export type IgnoredReason = 'wrong_budget' | 'wrong_budget_id' | 'wrong_currency' | 'stale_period';

export type GuardDecision =
  | { outcome: 'below' }
  | { outcome: 'ignored'; reason: IgnoredReason }
  | { outcome: 'would_disable' }
  | { outcome: 'disable' };

/** What the decision needs besides the message body. */
export interface GuardContext {
  /** The clock, in epoch ms. "Current month" is the UTC month of this instant. */
  now: number;
  /** The Pub/Sub message attributes, where Google puts `budgetId` and `billingAccountId`. */
  attributes?: Readonly<Record<string, string>> | undefined;
  /** The `hireframe-kill` budget ID. Unset or empty: the check is skipped, the name stays the identity. */
  expectedBudgetId?: string | undefined;
}

/** True when `start` parses, is not in the future, and is in the same UTC year and month as `now`. */
function inCurrentMonth(start: string, now: number): boolean {
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs) || startMs > now) return false;
  const a = new Date(startMs);
  const b = new Date(now);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

/**
 * Whether a budget message means "turn billing off" (ADR-059). Identity and staleness are checked
 * first, in order: budget name, budget ID (when one is configured), currency, then a period start
 * in the current UTC month. A message that fails any of them is `ignored` with a reason, whatever
 * its cost, so a replayed old message can never kill. Only then does the actual cost decide. The
 * forecast fields are ignored on purpose: a forecast is a guess, and the kill is a last resort.
 * In dry run the same message gives `would_disable` and nothing else happens.
 */
export function decideGuard(
  message: BudgetMessage,
  mode: GuardMode,
  context: GuardContext,
): GuardDecision {
  if (message.budgetDisplayName !== BILLING_GUARD.budgetDisplayName) {
    return { outcome: 'ignored', reason: 'wrong_budget' };
  }
  if (context.expectedBudgetId && context.attributes?.budgetId !== context.expectedBudgetId) {
    return { outcome: 'ignored', reason: 'wrong_budget_id' };
  }
  if (message.currencyCode !== BILLING_GUARD.currency) {
    return { outcome: 'ignored', reason: 'wrong_currency' };
  }
  if (!inCurrentMonth(message.costIntervalStart, context.now)) {
    return { outcome: 'ignored', reason: 'stale_period' };
  }
  if (message.costAmount < message.budgetAmount) return { outcome: 'below' };
  return { outcome: mode === 'armed' ? 'disable' : 'would_disable' };
}
