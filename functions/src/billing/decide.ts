import { BILLING_GUARD, type GuardMode } from '../config.js';
import type { BudgetMessage } from './schema.js';

export type GuardDecision =
  | { outcome: 'below' }
  | { outcome: 'ignored'; reason: 'wrong_budget' | 'wrong_currency' }
  | { outcome: 'would_disable' }
  | { outcome: 'disable' };

/**
 * Whether a budget message means "turn billing off" (ADR-059). Acts only for the
 * `hireframe-kill` budget, in GBP, when the actual cost has reached the budget. The forecast
 * fields are ignored on purpose: a forecast is a guess, and the kill is a last resort.
 * In dry run the same message gives `would_disable` and nothing else happens.
 */
export function decideGuard(message: BudgetMessage, mode: GuardMode): GuardDecision {
  if (message.budgetDisplayName !== BILLING_GUARD.budgetDisplayName) {
    return { outcome: 'ignored', reason: 'wrong_budget' };
  }
  if (message.currencyCode !== BILLING_GUARD.currency) {
    return { outcome: 'ignored', reason: 'wrong_currency' };
  }
  if (message.costAmount < message.budgetAmount) return { outcome: 'below' };
  return { outcome: mode === 'armed' ? 'disable' : 'would_disable' };
}
