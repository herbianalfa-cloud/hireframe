import { costPence } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DEFAULT_FX_USD_TO_GBP, MODELS, PRICES_USD_PER_MTOK } from '../config.js';
import { fakeTransport } from '../llm/fake-transport.js';
import type { LlmRequest } from '../llm/transport.js';
import { inputTokensFor, LOAD_LATENCY_MS, LOAD_UNIT_PENCE, loadTransport } from './transport.js';

function request(purpose: 'triage' | 'deepRead'): LlmRequest {
  return {
    purpose,
    model: MODELS[purpose],
    system: 'system',
    messages: [{ role: 'user', content: 'Title: Product Analyst\nCompany: Acme' }],
    schema: z.unknown(),
    timeoutMs: 10_000,
  };
}

describe('loadTransport', () => {
  it('sleeps the configured latency (with jitter) and returns the fake answer', async () => {
    const slept: number[] = [];
    let now = 0;
    const calls: [string, number, number][] = [];
    const transport = loadTransport({
      inner: fakeTransport(),
      sleep: (ms) => {
        slept.push(ms);
        now += ms;
        return Promise.resolve();
      },
      random: () => 0.5,
      clock: () => now,
      onSend: (purpose, start, end) => calls.push([purpose, start, end]),
    });
    const triage = await transport.send(request('triage'));
    const deep = await transport.send(request('deepRead'));
    await transport.countTokens(request('triage'));
    expect(slept).toEqual([
      LOAD_LATENCY_MS.triage,
      LOAD_LATENCY_MS.deepRead,
      LOAD_LATENCY_MS.countTokens,
    ]);
    expect(JSON.parse(triage.text ?? '{}')).toMatchObject({ pass: true });
    expect(deep.model).toContain('claude-sonnet-5-5');
    expect(calls).toEqual([
      ['triage', 0, LOAD_LATENCY_MS.triage],
      ['deepRead', LOAD_LATENCY_MS.triage, LOAD_LATENCY_MS.triage + LOAD_LATENCY_MS.deepRead],
    ]);
  });

  it('keeps jitter within ±25%', async () => {
    const slept: number[] = [];
    const run = async (random: number) => {
      const transport = loadTransport({
        inner: fakeTransport(),
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
        random: () => random,
      });
      await transport.send(request('deepRead'));
    };
    await run(0);
    await run(0.999);
    expect(slept[0]).toBe(6_000);
    expect(slept[1]).toBeLessThanOrEqual(10_000);
  });

  it('reports token counts that cost the real unit price', async () => {
    const transport = loadTransport({
      inner: fakeTransport(),
      sleep: () => Promise.resolve(),
      random: () => 0.5,
    });
    for (const purpose of ['triage', 'deepRead'] as const) {
      const response = await transport.send(request(purpose));
      const price = PRICES_USD_PER_MTOK[MODELS[purpose].id];
      if (!price) throw new Error('no price');
      const pence = costPence(response.tokens, price, DEFAULT_FX_USD_TO_GBP);
      expect(pence).toBeCloseTo(LOAD_UNIT_PENCE[purpose], 2);
      expect(await transport.countTokens(request(purpose))).toBe(inputTokensFor(purpose));
    }
  });
});
