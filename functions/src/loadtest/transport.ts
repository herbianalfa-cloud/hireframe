import { PRICES_USD_PER_MTOK, MODELS, DEFAULT_FX_USD_TO_GBP } from '../config.js';
import type { LlmRequest, LlmResponse, LlmTransport } from '../llm/transport.js';

/**
 * The load test's model transport: the fake answers (so verdicts are the ones the funnel tests
 * use) with production-like latency and token counts calibrated to the real unit costs, so the
 * run lease binds as it does in production. The fake's own counts leave out the system prompt.
 */
export const LOAD_LATENCY_MS = { triage: 1_200, deepRead: 8_000, countTokens: 150 } as const;
/** Real unit costs in pence (ADR-032 amendment: c₂ = 0.151p, c₃ = 1.0p). */
export const LOAD_UNIT_PENCE = { triage: 0.151, deepRead: 1.0 } as const;
/** Output tokens a call is assumed to produce; the input side is solved from the unit cost. */
const OUTPUT_TOKENS = { triage: 75, deepRead: 370 } as const;

export interface LoadTransportOptions {
  inner: LlmTransport;
  /** Injected, so a test needs no real waiting. */
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  fxUsdToGbp?: number;
  /** Called per send, for the run's call log. */
  onSend?: (purpose: 'triage' | 'deepRead', startedAt: number, endedAt: number) => void;
  clock?: () => number;
}

/** Input tokens that make one call cost `pence` with `outputTokens` out. */
export function inputTokensFor(
  purpose: 'triage' | 'deepRead',
  fxUsdToGbp: number = DEFAULT_FX_USD_TO_GBP,
): number {
  const price = PRICES_USD_PER_MTOK[MODELS[purpose].id];
  if (!price) throw new Error(`No price for ${MODELS[purpose].id}`);
  const usd = LOAD_UNIT_PENCE[purpose] / 100 / fxUsdToGbp;
  const outputUsd = (OUTPUT_TOKENS[purpose] * price.outputUsdPerMTok) / 1_000_000;
  return Math.round(((usd - outputUsd) * 1_000_000) / price.inputUsdPerMTok);
}

function jitter(base: number, random: () => number): number {
  return Math.round(base * (0.75 + random() * 0.5));
}

export function loadTransport(options: LoadTransportOptions): LlmTransport {
  const fx = options.fxUsdToGbp ?? DEFAULT_FX_USD_TO_GBP;
  const clock = options.clock ?? Date.now;
  return {
    async countTokens(request: LlmRequest) {
      await options.sleep(jitter(LOAD_LATENCY_MS.countTokens, options.random));
      if (request.purpose === 'triage' || request.purpose === 'deepRead') {
        return inputTokensFor(request.purpose, fx);
      }
      return options.inner.countTokens(request);
    },
    async send(request: LlmRequest): Promise<LlmResponse> {
      const purpose = request.purpose;
      if (purpose !== 'triage' && purpose !== 'deepRead') return options.inner.send(request);
      const startedAt = clock();
      await options.sleep(jitter(LOAD_LATENCY_MS[purpose], options.random));
      const response = await options.inner.send(request);
      options.onSend?.(purpose, startedAt, clock());
      return {
        ...response,
        tokens: {
          input: inputTokensFor(purpose, fx),
          output: OUTPUT_TOKENS[purpose],
          cacheRead: 0,
          cacheWrite: 0,
        },
      };
    },
  };
}
