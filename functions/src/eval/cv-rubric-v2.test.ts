import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEFAULT_FX_USD_TO_GBP } from '../config.js';
import type { LlmCallDeps } from '../llm/call.js';
import { EVAL_NOW, parseGolden } from './cases.js';
import { parseCvCases } from './cv-cases.js';
import { evaluateCvCase } from './cv-evaluate.js';
import { parseRecordings, replayTransport } from './recordings.js';
import { memoryUsage } from './runtime.js';

/**
 * Pins the rubric v2 totals of the committed CV recordings (CV quality review M4), so a later
 * rubric change shows up as a diff here. Re-pinned for the `cv-2026-10-19a` recordings (Fix B);
 * c08 is a thin profile that now skips its revision as not_fixable (L2). Replay only: no API key, no model call.
 */
const V2_TOTALS = {
  c01: 9.75,
  c02: 9.5,
  c03: 9.75,
  c04: 9.46,
  c05: 9.89,
  c06: 9.75,
  c07: 9.5,
  c08: 7.25,
} as const;

describe('rubric v2 over the committed recordings', () => {
  const golden = parseGolden(readFileSync('evals/golden.jsonl', 'utf8'));
  const cases = parseCvCases(readFileSync('evals/cv-cases.jsonl', 'utf8'), golden);
  const recordings = parseRecordings(readFileSync('evals/cv-recordings.jsonl', 'utf8'));

  it('scores every case as pinned, with none newly asking for a revision', async () => {
    const deps: LlmCallDeps = {
      transport: replayTransport(recordings),
      usage: memoryUsage(10_000),
      capPence: 10_000,
      fxUsdToGbp: DEFAULT_FX_USD_TO_GBP,
      now: () => EVAL_NOW,
    };
    const totals: Record<string, number> = {};
    for (const entry of cases) {
      const { result } = await evaluateCvCase(entry, golden, deps);
      totals[entry.id] = result.quality?.total ?? -1;
      expect(result.quality?.rubric).toBe('rubric-v2');
      expect(result.reviseCalls).toBe(0);
    }
    expect(totals).toEqual(V2_TOTALS);
  });
});
