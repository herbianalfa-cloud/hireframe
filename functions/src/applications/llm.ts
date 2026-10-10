import { randomUUID } from 'node:crypto';

import type { LlmCallDeps } from '../llm/call.js';
import type { LlmTransport } from '../llm/transport.js';
import { dailyCapped, type UsageStore } from '../llm/usage-store.js';

/**
 * The model deps for the `application` callable: the monthly cap (in `llmCall`) and the
 * application daily cap on the same usage store. `dailyCapped` counts a day's live reservations
 * by their ID prefix and throws on any other, so `newId` must start `application-`.
 */
export function applicationLlmDeps(input: {
  transport: LlmTransport;
  usage: UsageStore;
  dailyCapPence: number;
  capPence: number;
  fxUsdToGbp: number;
  newId?: () => string;
}): LlmCallDeps {
  return {
    transport: input.transport,
    usage: dailyCapped(input.usage, 'application', input.dailyCapPence),
    capPence: input.capPence,
    fxUsdToGbp: input.fxUsdToGbp,
    newId: input.newId ?? (() => `application-${randomUUID()}`),
  };
}
