import Anthropic from '@anthropic-ai/sdk';
import { costPence, type Usage } from '@hireframe/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MODELS, PRICES_USD_PER_MTOK, TOP_PRICE } from '../config.js';
import { setLogSink, type LogFields } from '../log.js';
import { llmCall, priceFor, type LlmCallDeps } from './call.js';
import { LlmOutputError, SpendCapExceededError } from './errors.js';
import type { LlmRequest, LlmResponse, LlmTransport } from './transport.js';
import { applyReserve, applySettle, emptyUsage, type UsageStore } from './usage-store.js';

const Schema = z.object({ answer: z.string().max(10) });
const NOW = new Date('2026-10-15T12:00:00Z');
const SECRET = 'Alex Example led onboarding for twelve clients';

function response(text: string | null, overrides: Partial<LlmResponse> = {}): LlmResponse {
  return {
    // The API reports the dated snapshot, not the alias that was requested.
    model: 'claude-haiku-4-5-20251001',
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
    expect(result).toEqual({
      data: { answer: 'ok' },
      model: 'claude-haiku-4-5-20251001',
      costPence: 0.16,
    });
    expect(usage.doc()).toMatchObject({
      spendPence: 0.16,
      reservations: {},
      calls: { 'claude-haiku-4-5-20251001': 1 },
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

  it('charges a stale reservation (a call that never settled) its worst case', async () => {
    const stale = { pence: 1_400, at: new Date(NOW.getTime() - 20 * 60_000) };
    const usage = memoryStore({ ...emptyUsage(1500, NOW), reservations: { old: stale } });
    await call(deps({ transport: transport([response('{"answer":"ok"}')]), usage }));
    expect(usage.doc()).toMatchObject({
      reservations: {},
      spendPence: 1_400.16,
      byPurpose: { unsettled: 1_400, addFact: 0.16 },
    });
  });

  it('counts a stale reservation against the cap before the next call runs', async () => {
    const stale = { pence: 1_499.9, at: new Date(NOW.getTime() - 20 * 60_000) };
    const usage = memoryStore({ ...emptyUsage(1500, NOW), reservations: { old: stale } });
    const t = transport([response('{"answer":"ok"}')]);
    await expect(call(deps({ transport: t, usage }))).rejects.toBeInstanceOf(SpendCapExceededError);
    expect(t.sent).toHaveLength(0);
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

  it('charges the worst case when a timeout aborted the send', async () => {
    const usage = memoryStore();
    const aborted = new Anthropic.APIUserAbortError();
    await expect(call(deps({ transport: transport([aborted]), usage }))).rejects.toBe(aborted);
    expect(usage.doc()?.spendPence).toBeCloseTo(1.728, 4);
  });

  describe('time budget (addFact: 45 s per send, 90 s per call, 20 s to count tokens)', () => {
    /** The first send takes `firstSendMs` of wall-clock time and returns invalid JSON. */
    function slowFirstReply(firstSendMs: number) {
      let clock = NOW.getTime();
      const t = transport([response('not json'), response('{"answer":"ok"}')]);
      const send = t.send.bind(t);
      t.send = (request) => {
        const reply = send(request);
        clock += firstSendMs;
        return reply;
      };
      return { t, now: () => new Date(clock) };
    }

    it('trims the retry send to what is left of the budget', async () => {
      const { t, now } = slowFirstReply(50_000);
      await expect(call(deps({ transport: t, now }))).resolves.toMatchObject({
        data: { answer: 'ok' },
      });
      expect(t.sent.map((request) => request.timeoutMs)).toEqual([45_000, 20_000]);
    });

    it('skips the retry when too little of the budget is left', async () => {
      const { t, now } = slowFirstReply(75_000);
      const error: unknown = await call(deps({ transport: t, now })).catch((e: unknown) => e);
      expect(error).toMatchObject({ failure: 'invalid_json' });
      expect(t.sent).toHaveLength(1);
    });
  });

  it('prices an unknown model at the top rate and says so', async () => {
    const t = transport([response('{"answer":"ok"}', { model: 'claude-future-9' })]);
    const result = await call(deps({ transport: t }));
    // Top rate is Sonnet 5.5: 1000 × $2/M + 200 × $10/M = $0.004 → 0.32p
    expect(result.costPence).toBeCloseTo(0.32, 6);
    expect(logs.some((line) => line.event === 'llm.unknown_model_price')).toBe(true);
  });

  it('reports a truly unknown model as an error, once per model', () => {
    priceFor('claude-future-10');
    priceFor('claude-future-10');
    priceFor('claude-future-11-20270101');
    const reports = logs.filter((line) => line.event === 'llm.unknown_model_price');
    expect(reports.map((line) => line.model)).toEqual([
      'claude-future-10',
      'claude-future-11-20270101',
    ]);
  });

  it('prices a dated snapshot exactly as its alias, without a warning', async () => {
    const dated = await call(
      deps({
        transport: transport([response('{"answer":"ok"}', { model: 'claude-haiku-4-5-20251001' })]),
      }),
    );
    const alias = await call(
      deps({
        transport: transport([response('{"answer":"ok"}', { model: 'claude-haiku-4-5' })]),
      }),
    );
    // 1000 × $1/M + 200 × $5/M at 0.8, not the top rate (0.32p)
    expect(dated.costPence).toBe(0.16);
    expect(dated.costPence).toBe(alias.costPence);
    expect(logs.some((line) => line.event === 'llm.unknown_model_price')).toBe(false);
  });

  it('gives an unknown ID the top price, dated or not', () => {
    expect(priceFor('claude-mystery-1')).toBe(TOP_PRICE);
    expect(priceFor('claude-mystery-1-20260101')).toBe(TOP_PRICE);
  });

  it.each(Object.entries(MODELS))(
    'resolves the configured %s model, bare and dated, to a price-table entry',
    (_purpose, model) => {
      const entry = PRICES_USD_PER_MTOK[model.id];
      expect(entry).toBeDefined();
      expect(priceFor(model.id)).toBe(entry);
      expect(priceFor(`${model.id}-20251001`)).toBe(entry);
      expect(priceFor(`fake:${model.id}-20251001`)).toBe(entry);
    },
  );

  it('reserves a cached prompt at the cache-write rate and settles below it', async () => {
    const usage = memoryStore();
    const reserved: number[] = [];
    const spy: UsageStore = {
      reserve(input) {
        reserved.push(input.pence);
        return usage.reserve(input);
      },
      settle: (input) => usage.settle(input),
    };
    await llmCall(deps({ transport: transport([response('{"answer":"ok"}')]), usage: spy }), {
      purpose: 'deepRead',
      system: 'Return JSON.',
      user: 'x',
      schema: Schema,
      cacheSystem: true,
    });
    // 1,000 counted → 1,600 bound; Sonnet 5.5 writes at $2.50, so input costs more than $2
    const price = PRICES_USD_PER_MTOK['claude-sonnet-5-5'];
    if (!price) throw new Error('no price');
    const bound = costPence(
      { input: 1_600, output: MODELS.deepRead.maxTokens, cacheRead: 0, cacheWrite: 0 },
      { ...price, inputUsdPerMTok: price.cacheWriteUsdPerMTok },
      0.8,
    );
    expect(reserved).toEqual([bound]);
  });

  it('prices a fake-transport model at the real model rate, without a warning', async () => {
    const t = transport([response('{"answer":"ok"}', { model: 'fake:claude-haiku-4-5' })]);
    const usage = memoryStore();
    const result = await call(deps({ transport: t, usage }));
    expect(result).toMatchObject({ model: 'fake:claude-haiku-4-5', costPence: 0.16 });
    expect(usage.doc()?.calls).toEqual({ 'fake:claude-haiku-4-5': 1 });
    expect(logs.some((line) => line.event === 'llm.unknown_model_price')).toBe(false);
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

describe('llmCall maxSends', () => {
  it('makes one send only when maxSends is 1, leaving the retry to the caller', async () => {
    const t = transport([response('not json'), response('{"answer":"ok"}')]);
    const error: unknown = await llmCall(deps({ transport: t }), {
      purpose: 'addFact',
      system: 'Return JSON.',
      user: 'x',
      schema: Schema,
      maxSends: 1,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ failure: 'invalid_json' });
    expect(t.sent).toHaveLength(1);
  });
});
