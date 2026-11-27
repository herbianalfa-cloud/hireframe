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
  /** The clock, in epoch ms. "Current month" is the America/Los_Angeles month of this instant. */
  now: number;
  /** The Pub/Sub message attributes, where Google puts `budgetId` and `billingAccountId`. */
  attributes?: Readonly<Record<string, string>> | undefined;
  /** The `hireframe-kill` budget ID. Unset or empty: the check is skipped, the name stays the identity. */
  expectedBudgetId?: string | undefined;
}

const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: 'numeric',
});

/** The year and month of an instant in America/Los_Angeles, as `year-month`. */
function pacificMonth(ms: number): string {
  const parts = PACIFIC.formatToParts(ms);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}

/**
 * True when `start` parses, is not in the future, and is in the same year and month as `now`,
 * both read in America/Los_Angeles (the zone of the budget period, to be confirmed by the
 * captured message's start hour: 07:00Z in PDT, 08:00Z in PST).
 */
function inCurrentMonth(start: string, now: number): boolean {
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs) || startMs > now) return false;
  return pacificMonth(startMs) === pacificMonth(now);
}

/**
 * Whether a budget message means "turn billing off" (ADR-059). Identity and staleness are checked
 * first, in order: budget name, budget ID (when one is configured), currency, then a period start
 * in the current Pacific (America/Los_Angeles) month. A message that fails any of them is `ignored` with a reason, whatever
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
