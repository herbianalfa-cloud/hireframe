import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { TokenCounts } from '@hireframe/shared';
import type { z } from 'zod';

import type { LlmPurpose, ModelConfig } from '../config.js';

/**
 * The narrow seam between `llm.call()` and the Anthropic SDK, so the spend-cap and validation
 * logic is testable offline and the emulator can use a fake (ADR-016, ADR-017).
 * Requests never carry tools: the output is fixed by a JSON schema.
 */
export interface LlmRequest {
  purpose: LlmPurpose;
  model: ModelConfig;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  schema: z.ZodType;
}

export interface LlmResponse {
  model: string;
  stopReason: string | null;
  /** Concatenated text blocks, or null when the model returned none. */
  text: string | null;
  tokens: TokenCounts;
}

export interface LlmTransport {
  countTokens(request: LlmRequest): Promise<number>;
  send(request: LlmRequest): Promise<LlmResponse>;
}

const COUNT_TOKENS_TIMEOUT_MS = 20_000;

function outputConfig(request: LlmRequest): Anthropic.OutputConfig {
  const { schema } = zodOutputFormat(request.schema);
  return {
    format: { type: 'json_schema', schema },
    ...(request.model.effort ? { effort: request.model.effort } : {}),
  };
}

/** The real transport. The SDK retries 408/409/429/5xx and connection errors twice. */
export function anthropicTransport(apiKey: string): LlmTransport {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return {
    async countTokens(request) {
      const result = await client.messages.countTokens(
        {
          model: request.model.id,
          system: request.system,
          messages: request.messages,
          output_config: outputConfig(request),
        },
        { timeout: COUNT_TOKENS_TIMEOUT_MS },
      );
      return result.input_tokens;
    },

    async send(request) {
      // Streamed so long outputs never hit an idle HTTP timeout; only the final message is used.
      const message = await client.messages
        .stream(
          {
            model: request.model.id,
            max_tokens: request.model.maxTokens,
            system: request.system,
            messages: request.messages,
            output_config: outputConfig(request),
          },
          { timeout: request.model.timeoutMs },
        )
        .finalMessage();
      const text = message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      return {
        model: message.model,
        stopReason: message.stop_reason,
        text: text === '' ? null : text,
        tokens: {
          input: message.usage.input_tokens,
          output: message.usage.output_tokens,
          cacheRead: message.usage.cache_read_input_tokens ?? 0,
          cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}

/**
 * True when a failed request may still have been billed (the connection dropped or timed out
 * after the model started). Requests the API rejected with a status code were not.
 */
export function mayHaveBeenBilled(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true;
  return !(error instanceof Anthropic.APIError);
}
