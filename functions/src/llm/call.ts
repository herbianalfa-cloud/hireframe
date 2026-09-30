import { randomUUID } from 'node:crypto';

import { costPence, monthKey, worstCasePence, type ModelPrice } from '@hireframe/shared';
import type { z } from 'zod';

import { MODELS, PRICES_USD_PER_MTOK, TOP_PRICE, type LlmPurpose } from '../config.js';
import { errorFields, log } from '../log.js';
import { LlmOutputError, type LlmOutputFailure } from './errors.js';
import {
  mayHaveBeenBilled,
  type LlmRequest,
  type LlmResponse,
  type LlmTransport,
} from './transport.js';
import type { UsageStore } from './usage-store.js';

/**
 * `llm.call()`: the only way functions call Anthropic (CLAUDE.md, ADR-016). Per attempt:
 * count tokens → reserve the worst case against the monthly cap (throws before any API call if
 * it doesn't fit) → send → settle the actual cost, pruning stale reservations. Output is
 * validated with zod; an invalid answer gets one retry with the issue codes appended.
 * No tools, no beta features, fixed output schema.
 */
export interface LlmCallDeps {
  transport: LlmTransport;
  usage: UsageStore;
  capPence: number;
  fxUsdToGbp: number;
  now?: () => Date;
  newId?: () => string;
}

export interface LlmCallInput<T> {
  purpose: LlmPurpose;
  system: string;
  /** Untrusted content must already be wrapped as data by the caller (see cv/prompt.ts). */
  user: string;
  schema: z.ZodType<T>;
}

export interface LlmCallResult<T> {
  data: T;
  model: string;
  costPence: number;
}

const MAX_ATTEMPTS = 2;

/** countTokens can undercount slightly (e.g. structured-output overhead); reserve a margin. */
function inputTokenBound(counted: number): number {
  return Math.ceil(counted * 1.1) + 500;
}

function priceFor(model: string): ModelPrice {
  const price = PRICES_USD_PER_MTOK[model];
  if (price) return price;
  log.warn('llm.unknown_model_price', { model });
  return TOP_PRICE;
}

const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Issue paths and codes only: zod messages can echo the model's (CV-derived) output. */
function issueSummary(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
    .join('; ');
}

export async function llmCall<T>(
  deps: LlmCallDeps,
  input: LlmCallInput<T>,
): Promise<LlmCallResult<T>> {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const model = MODELS[input.purpose];
  const messages: LlmRequest['messages'] = [{ role: 'user', content: input.user }];
  let totalPence = 0;

  async function attempt(): Promise<LlmResponse> {
    const request: LlmRequest = {
      purpose: input.purpose,
      model,
      system: input.system,
      messages,
      schema: input.schema,
    };
    const inputTokens = inputTokenBound(await deps.transport.countTokens(request));
    const reservedPence = worstCasePence(
      inputTokens,
      model.maxTokens,
      priceFor(model.id),
      deps.fxUsdToGbp,
    );
    const month = monthKey(now());
    const id = newId();
    try {
      await deps.usage.reserve({
        month,
        id,
        pence: reservedPence,
        capPence: deps.capPence,
        now: now(),
      });
    } catch (error) {
      log.warn('llm.spend_cap', { purpose: input.purpose, reservedPence, capPence: deps.capPence });
      throw error;
    }

    let response: LlmResponse;
    try {
      response = await deps.transport.send(request);
    } catch (error) {
      // A dropped connection may still have been billed: count the worst case, not zero.
      const charged = mayHaveBeenBilled(error) ? reservedPence : 0;
      totalPence += charged;
      await deps.usage.settle({
        month,
        id,
        now: now(),
        model: model.id,
        purpose: input.purpose,
        tokens: NO_TOKENS,
        costPence: charged,
      });
      log.error('llm.failed', {
        purpose: input.purpose,
        chargedPence: charged,
        ...errorFields(error),
      });
      throw error;
    }

    const cost = costPence(response.tokens, priceFor(response.model), deps.fxUsdToGbp);
    totalPence += cost;
    await deps.usage.settle({
      month,
      id,
      now: now(),
      model: response.model,
      purpose: input.purpose,
      tokens: response.tokens,
      costPence: cost,
    });
    log.info('llm.called', {
      purpose: input.purpose,
      model: response.model,
      stopReason: response.stopReason ?? 'none',
      inputTokens: response.tokens.input,
      outputTokens: response.tokens.output,
      costPence: cost,
    });
    return response;
  }

  for (let attemptNo = 1; ; attemptNo++) {
    const response = await attempt();
    if (response.stopReason === 'refusal') throw new LlmOutputError('refusal', totalPence);
    if (response.stopReason === 'max_tokens') throw new LlmOutputError('max_tokens', totalPence);
    if (response.text === null) throw new LlmOutputError('no_text', totalPence);

    let failure: LlmOutputFailure;
    let feedback: string;
    try {
      const parsed = input.schema.safeParse(JSON.parse(response.text));
      if (parsed.success) {
        return { data: parsed.data, model: response.model, costPence: totalPence };
      }
      failure = 'schema';
      feedback = issueSummary(parsed.error.issues);
    } catch {
      failure = 'invalid_json';
      feedback = 'the reply was not valid JSON';
    }

    log.warn('llm.output_invalid', { purpose: input.purpose, attempt: attemptNo, failure });
    if (attemptNo >= MAX_ATTEMPTS) throw new LlmOutputError(failure, totalPence);
    messages.push(
      { role: 'assistant', content: response.text },
      {
        role: 'user',
        content: `That output failed validation (${feedback}). Reply again with the complete corrected JSON only.`,
      },
    );
  }
}
