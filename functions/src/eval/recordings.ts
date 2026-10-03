import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { LlmRequest, LlmResponse, LlmTransport } from '../llm/transport.js';

/**
 * Recorded model answers for the eval (ADR-036). CI replays them, so no Anthropic key is ever in
 * GitHub; `LIVE=1 npm run eval` calls the API and records fresh ones. A recording is keyed by
 * everything that shapes the answer: model, effort, max tokens, system prompt, caching, messages
 * and the output schema. Change any of them and replay fails with "recordings stale".
 */
export const RecordingSchema = z.object({
  /** SHA-256 of the request (named so secret scanners don't read it as an API key). */
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  purpose: z.string(),
  model: z.string(),
  stopReason: z.string().nullable(),
  text: z.string().nullable(),
  tokens: z.object({
    input: z.int().min(0),
    output: z.int().min(0),
    cacheRead: z.int().min(0),
    cacheWrite: z.int().min(0),
  }),
});
export type Recording = z.infer<typeof RecordingSchema>;

export function recordingKey(request: LlmRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        model: request.model.id,
        effort: request.model.effort ?? null,
        maxTokens: request.model.maxTokens,
        system: request.system,
        cacheSystem: request.cacheSystem ?? false,
        messages: request.messages,
        schema: z.toJSONSchema(request.schema),
      }),
    )
    .digest('hex');
}

export function parseRecordings(jsonl: string): Map<string, Recording> {
  const recordings = new Map<string, Recording>();
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    const recording = RecordingSchema.parse(JSON.parse(line));
    recordings.set(recording.requestHash, recording);
  }
  return recordings;
}

export function formatRecordings(recordings: Iterable<Recording>): string {
  return [...recordings]
    .sort((a, b) => (a.requestHash < b.requestHash ? -1 : a.requestHash > b.requestHash ? 1 : 0))
    .map((recording) => JSON.stringify(recording))
    .join('\n')
    .concat('\n');
}

export class RecordingMissingError extends Error {
  override name = 'RecordingMissingError';
}

function toResponse(recording: Recording): LlmResponse {
  return {
    model: recording.model,
    stopReason: recording.stopReason,
    text: recording.text,
    tokens: recording.tokens,
  };
}

/** Replays recordings; a request with no recording fails (the prompts changed). */
export function replayTransport(recordings: ReadonlyMap<string, Recording>): LlmTransport & {
  used: Set<string>;
} {
  const used = new Set<string>();
  return {
    used,
    countTokens: (request) =>
      Promise.resolve(
        Math.ceil(
          (request.system.length + request.messages.reduce((n, m) => n + m.content.length, 0)) / 3,
        ),
      ),
    send(request) {
      const key = recordingKey(request);
      const recording = recordings.get(key);
      if (!recording) {
        return Promise.reject(new RecordingMissingError(`no recording for ${request.purpose}`));
      }
      used.add(key);
      return Promise.resolve(toResponse(recording));
    },
  };
}

/** Calls the real transport and records every answer. */
export function recordingTransport(inner: LlmTransport): LlmTransport & {
  recorded: Map<string, Recording>;
} {
  const recorded = new Map<string, Recording>();
  return {
    recorded,
    countTokens: (request) => inner.countTokens(request),
    async send(request) {
      const response = await inner.send(request);
      const key = recordingKey(request);
      recorded.set(key, {
        requestHash: key,
        purpose: request.purpose,
        model: response.model,
        stopReason: response.stopReason,
        text: response.text,
        tokens: response.tokens,
      });
      return response;
    },
  };
}
