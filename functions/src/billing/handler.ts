import type { GuardMode } from '../config.js';
import { HttpError } from '../http/client.js';
import { log } from '../log.js';
import { BillingClientError, type BillingClient } from './client.js';
import { decideGuard } from './decide.js';
import { parseBudgetMessage } from './schema.js';

export interface GuardDeps {
  mode: GuardMode;
  /**
   * Built only when a decision needs the network, so a dry run, a message below the threshold and
   * an invalid message make no network call at all (not even to the metadata server).
   */
  billing: () => BillingClient;
}

/**
 * What the owner reads in the logs: a stable code, never message text or a response body.
 * A 403 is the permission the guard lacks while in dry run, and the one to watch when arming.
 */
export function failureCode(error: unknown): { code: string; status?: number } {
  if (error instanceof HttpError) {
    if (error.code === 'http_status' && error.status === 403) {
      return { code: 'permission_denied', status: 403 };
    }
    if (error.code === 'http_status' && error.status === 401) {
      return { code: 'unauthenticated', status: 401 };
    }
    return { code: error.code, ...(error.status === undefined ? {} : { status: error.status }) };
  }
  if (error instanceof BillingClientError) return { code: error.code };
  return { code: 'unexpected' };
}

/**
 * The billing kill switch (ADR-059). One budget message in, at most one write out.
 * Never throws and never re-publishes: the trigger is a message this function can't cause.
 */
export async function runGuard(data: string, deps: GuardDeps): Promise<void> {
  const { mode } = deps;
  const message = parseBudgetMessage(data);
  if (!message) {
    log.warn('billing_guard.invalid', { mode });
    return;
  }
  const decision = decideGuard(message, mode);
  const amounts = { mode, cost: message.costAmount, budget: message.budgetAmount };
  switch (decision.outcome) {
    case 'ignored':
      log.info('billing_guard.ignored', { mode, reason: decision.reason });
      return;
    case 'below':
      log.info('billing_guard.below', amounts);
      return;
    case 'would_disable':
      log.warn('billing_guard.would_disable', amounts);
      return;
    case 'disable':
      break;
  }

  let step: 'project' | 'read' | 'disable' = 'project';
  try {
    const billing = deps.billing();
    const projectId = await billing.projectId();
    step = 'read';
    if (!(await billing.billingEnabled(projectId))) {
      log.warn('billing_guard.already_disabled', amounts);
      return;
    }
    step = 'disable';
    const { stillEnabled } = await billing.disableBilling(projectId);
    if (stillEnabled) {
      log.error('billing_guard.failed', { ...amounts, step, code: 'still_enabled' });
      return;
    }
    log.error('billing_guard.disabled', amounts);
  } catch (error) {
    log.error('billing_guard.failed', { ...amounts, step, ...failureCode(error) });
  }
}
