import Anthropic from '@anthropic-ai/sdk';
import type { Usage } from '@hireframe/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { setLogSink, type LogFields } from '../log.js';
import { llmCall, type LlmCallDeps } from './call.js';
import { LlmOutputError, SpendCapExceededError } from './errors.js';
import type { LlmRequest, LlmResponse, LlmTransport } from './transport.js';
import { applyReserve, applySettle, emptyUsage, type UsageStore } from './usage-store.js';

const Schema = z.object({ answer: z.string().max(10) });
const NOW = new Date('2026-10-15T12:00:00Z');
const SECRET = 'Alex Example led onboarding for twelve clients';

function response(text: string | null, overrides: Partial<LlmResponse> = {}): LlmResponse {
  return {
    model: 'claude-haiku-4-5',
    stopReason: 'end_turn',
    text,
    tokens: { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

/** A usage store in memory, using the same pure transitions as the Firestore one. */
function memoryStore(initial?: Usage): UsageStore & { doc: () => Usage | undefined } {
  let doc = initial;
  return {
    doc: () => doc,
    reserve(input) {
      doc = applyReserve(doc ?? emptyUsage(input.capPence, input.now), input);
      return Promise.resolve();
    },
    settle(input) {
      doc = applySettle(doc ?? emptyUsage(0, input.now), input);
      return Promise.resolve();
    },
  };
}

function transport(replies: (LlmResponse | Error)[]): LlmTransport & { sent: LlmRequest[] } {
  const sent: LlmRequest[] = [];
  return {
    sent,
    countTokens: () => Promise.resolve(1_000),
    send(request) {
      sent.push(structuredClone({ ...request, schema: undefined }) as unknown as LlmRequest);
      const next = replies.shift();
      if (!next) throw new Error('no reply queued');
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

let logs: LogFields[] = [];

beforeEach(() => {
  logs = [];
  setLogSink((_level, event, fields) => logs.push({ event, ...fields }));
});

afterEach(() => {
  setLogSink();
});

function deps(overrides: Partial<LlmCallDeps> & Pick<LlmCallDeps, 'transport'>): LlmCallDeps {
  let n = 0;
  return {
    usage: memoryStore(),
    capPence: 1500,
    fxUsdToGbp: 0.8,
    now: () => NOW,
    newId: () => `r${String(++n)}`,
    ...overrides,
  };
}

const call = (d: LlmCallDeps) =>
  llmCall(d, {
    purpose: 'addFact',
    system: 'Return JSON.',
    user: `<data>${SECRET}</data>`,
    schema: Schema,
  });

describe('llmCall', () => {
  it('returns validated data and records the actual cost, releasing the reservation', async () => {
    const usage = memoryStore();
    const result = await call(deps({ transport: transport([response('{"answer":"ok"}')]), usage }));
    // 1000 input × $1/M + 200 output × $5/M = $0.002 → 0.16p at 0.8
    expect(result).toEqual({ data: { answer: 'ok' }, model: 'claude-haiku-4-5', costPence: 0.16 });
    expect(usage.doc()).toMatchObject({
      spendPence: 0.16,
      reservations: {},
      calls: { 'claude-haiku-4-5': 1 },
      byPurpose: { addFact: 0.16 },
    });
  });

  it('blocks the call before sending when the worst case exceeds the cap', async () => {
    const t = transport([response('{"answer":"ok"}')]);
    const usage = memoryStore({ ...emptyUsage(1500, NOW), spendPence: 1499.99 });
    await expect(call(deps({ transport: t, usage }))).rejects.toBeInstanceOf(SpendCapExceededError);
    expect(t.sent).toHaveLength(0);
    expect(usage.doc()?.spendPence).toBe(1499.99);
    expect(usage.doc()?.reservations).toEqual({});
  });

  it('prunes stale reservations when it settles', async () => {
    const stale = { pence: 1_400, at: new Date(NOW.getTime() - 20 * 60_000) };
    const usage = memoryStore({ ...emptyUsage(1500, NOW), reservations: { old: stale } });
    await call(deps({ transport: transport([response('{"answer":"ok"}')]), usage }));
    expect(usage.doc()?.reservations).toEqual({});
  });

  it('retries once with the issue codes when the output fails validation, then succeeds', async () => {
    const t = transport([
      response('{"answer":"far too long an answer"}'),
      response('{"answer":"ok"}'),
    ]);
    const result = await call(deps({ transport: t }));
    expect(result.data).toEqual({ answer: 'ok' });
    expect(result.costPence).toBeCloseTo(0.32, 6);
    expect(t.sent).toHaveLength(2);
    const retry = t.sent[1]?.messages.at(-1)?.content ?? '';
    expect(retry).toContain('answer: too_big');
  });

  it('gives up after the retry with a typed error carrying the total cost', async () => {
    const t = transport([response('not json'), response('{"wrong":1}')]);
    const error: unknown = await call(deps({ transport: t })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmOutputError);
    expect(error).toMatchObject({ failure: 'schema', costPence: 0.32 });
  });

  it.each([
    ['refusal', 'refusal'],
    ['max_tokens', 'max_tokens'],
  ])('fails without retrying on stop reason %s', async (stopReason, failure) => {
    const t = transport([response(null, { stopReason })]);
    await expect(call(deps({ transport: t }))).rejects.toMatchObject({ failure });
    expect(t.sent).toHaveLength(1);
  });

  it('charges nothing when the API rejected the request, and releases the reservation', async () => {
    const usage = memoryStore();
    const rejected = new Anthropic.BadRequestError(400, undefined, 'bad', new Headers());
    await expect(call(deps({ transport: transport([rejected]), usage }))).rejects.toBe(rejected);
    expect(usage.doc()).toMatchObject({ spendPence: 0, reservations: {} });
  });

  it('charges the worst case when the connection dropped (it may have been billed)', async () => {
    const usage = memoryStore();
    const dropped = new Anthropic.APIConnectionTimeoutError();
    await expect(call(deps({ transport: transport([dropped]), usage }))).rejects.toBe(dropped);
    // (1000×1.1+500) input × $1/M + 4000 output × $5/M = $0.0216 → 1.728p
    expect(usage.doc()?.spendPence).toBeCloseTo(1.728, 4);
    expect(usage.doc()?.reservations).toEqual({});
  });

  it('prices an unknown model at the top rate and says so', async () => {
    const t = transport([response('{"answer":"ok"}', { model: 'claude-future-9' })]);
    const result = await call(deps({ transport: t }));
    // Top rate is Sonnet 5.5: 1000 × $2/M + 200 × $10/M = $0.004 → 0.32p
    expect(result.costPence).toBeCloseTo(0.32, 6);
    expect(logs.some((line) => line.event === 'llm.unknown_model_price')).toBe(true);
  });

  it('never logs the prompt or the model output', async () => {
    const t = transport([response(`{"answer":"${'x'.repeat(20)}"}`), response(`{"answer":"ok"}`)]);
    await call(deps({ transport: t }));
    const text = JSON.stringify(logs);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('x'.repeat(20));
  });

  it('uses the configured model per purpose, with no tools', async () => {
    const t = transport([response('{"answer":"ok"}')]);
    await call(deps({ transport: t }));
    expect(t.sent[0]?.model.id).toBe('claude-haiku-4-5');
    expect(t.sent[0]).not.toHaveProperty('tools');
  });
});
