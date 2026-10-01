import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { z } from 'zod';

import { MODELS } from '../config.js';
import { anthropicTransport, mayHaveBeenBilled, type LlmRequest } from './transport.js';

const SECRET = 'Alex Example led onboarding for twelve clients';

function request(timeoutMs: number): LlmRequest {
  return {
    purpose: 'addFact',
    model: MODELS.addFact,
    system: 'Return JSON.',
    messages: [{ role: 'user', content: `<note>${SECRET}</note>` }],
    schema: z.object({ answer: z.string() }),
    timeoutMs,
  };
}

function sse(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

const MESSAGE_START = sse('message_start', {
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  },
});

const MESSAGE_REST = [
  sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '{"answer":"ok"}' } }),
  sse('content_block_stop', { index: 0 }),
  sse('message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 7 },
  }),
  sse('message_stop', {}),
];

/** A streamed reply: headers at once, then `chunks`, then either the end or a stall. */
function streamingFetch(chunks: string[], stall: boolean) {
  return (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        if (!stall) controller.close();
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('aborted', 'AbortError'));
        });
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };
}

describe('anthropicTransport', () => {
  it('returns the streamed text and token counts', async () => {
    const t = anthropicTransport('test-key', {
      fetch: streamingFetch([MESSAGE_START, ...MESSAGE_REST], false),
    });
    await expect(t.send(request(5_000))).resolves.toEqual({
      model: 'claude-haiku-4-5',
      stopReason: 'end_turn',
      text: '{"answer":"ok"}',
      tokens: { input: 10, output: 7, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it('aborts a stream that stalls after the headers, and treats it as possibly billed', async () => {
    const t = anthropicTransport('test-key', { fetch: streamingFetch([MESSAGE_START], true) });
    const started = Date.now();
    const error: unknown = await t.send(request(200)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Anthropic.APIUserAbortError);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(mayHaveBeenBilled(error)).toBe(true);
  });
});

describe('SDK logging', () => {
  const spies: MockInstance<(...data: unknown[]) => void>[] = [];

  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      spies.push(vi.spyOn(console, level).mockImplementation(() => undefined));
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  it('never prints the request, even with ANTHROPIC_LOG=debug', async () => {
    const rejecting = () =>
      Promise.resolve(
        new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const t = anthropicTransport('test-key', { fetch: rejecting });
    await expect(t.countTokens(request(5_000))).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    await expect(t.send(request(5_000))).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    const printed = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain('test-key');
  });
});

describe('mayHaveBeenBilled', () => {
  it('is false only for requests the API rejected with a status code', () => {
    expect(mayHaveBeenBilled(new Anthropic.APIConnectionTimeoutError())).toBe(true);
    expect(mayHaveBeenBilled(new Anthropic.APIUserAbortError())).toBe(true);
    expect(mayHaveBeenBilled(new Error('boom'))).toBe(true);
    expect(
      mayHaveBeenBilled(new Anthropic.BadRequestError(400, undefined, 'bad', new Headers())),
    ).toBe(false);
  });
});
