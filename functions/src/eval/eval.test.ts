import { readFileSync } from 'node:fs';

import { DeepReadOutputSchema, TriageOutputSchema } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { DEFAULT_FX_USD_TO_GBP, MODELS } from '../config.js';
import { fakeTransport } from '../llm/fake-transport.js';
import type { LlmRequest } from '../llm/transport.js';
import { applyReserve, applySettle, emptyUsage, type UsageStore } from '../llm/usage-store.js';
import { EVAL_NOW, parseGolden } from './cases.js';
import { evaluateCase, titleSuite, type CaseResult } from './evaluate.js';
import {
  formatRecordings,
  parseRecordings,
  recordingKey,
  RecordingMissingError,
  recordingTransport,
  replayTransport,
} from './recordings.js';
import { AGREEMENT_GATE, formatReport, gate, summarise } from './report.js';

const cases = parseGolden(readFileSync('evals/golden.jsonl', 'utf8'));

function usage(): UsageStore {
  let doc = emptyUsage(10_000, EVAL_NOW);
  return {
    reserve(input) {
      doc = applyReserve(doc, input);
      return Promise.resolve();
    },
    settle(input) {
      doc = applySettle(doc, input);
      return Promise.resolve();
    },
  };
}

const deps = (transport: Parameters<typeof evaluateCase>[1]['transport']) => ({
  transport,
  usage: usage(),
  capPence: 10_000,
  fxUsdToGbp: DEFAULT_FX_USD_TO_GBP,
  now: () => EVAL_NOW,
});

describe('recordings', () => {
  it('replays exactly what was recorded, so CI gets the live verdicts with no key', async () => {
    const recorder = recordingTransport(fakeTransport());
    const live: CaseResult[] = [];
    for (const entry of cases.slice(0, 12)) live.push(await evaluateCase(entry, deps(recorder)));
    const stored = parseRecordings(formatRecordings(recorder.recorded.values()));
    const replay = replayTransport(stored);
    const replayed: CaseResult[] = [];
    for (const entry of cases.slice(0, 12)) replayed.push(await evaluateCase(entry, deps(replay)));
    expect(replayed).toEqual(live);
    expect(replay.used.size).toBe(stored.size);
  });

  it('fails replay when a prompt changes', async () => {
    const replay = replayTransport(new Map());
    const apply = cases.find((c) => c.id === 'g01');
    if (!apply) throw new Error('g01 missing');
    await expect(evaluateCase(apply, deps(replay))).rejects.toBeInstanceOf(RecordingMissingError);
  });

  it('keys on everything that shapes an answer, and nothing else', () => {
    const base: LlmRequest = {
      purpose: 'triage',
      model: MODELS.triage,
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Posting' }],
      schema: TriageOutputSchema,
      timeoutMs: 25_000,
    };
    const key = recordingKey(base);
    expect(recordingKey({ ...base, timeoutMs: 1 })).toBe(key);
    for (const changed of [
      { ...base, system: 'Other system prompt' },
      { ...base, messages: [{ role: 'user' as const, content: 'Other posting' }] },
      { ...base, model: MODELS.deepRead },
      { ...base, schema: DeepReadOutputSchema },
      { ...base, cacheSystem: true },
    ]) {
      expect(recordingKey(changed)).not.toBe(key);
    }
  });
});

describe('the eval report and gate', () => {
  const result = (
    id: string,
    label: CaseResult['label'],
    verdict: CaseResult['verdict'],
    injection = false,
  ): CaseResult => ({
    id,
    label,
    verdict,
    stage: 's3',
    drift: false,
    costPence: 0.5,
    injection,
  });

  it('computes agreement and the confusion matrix over labelled cases', () => {
    const summary = summarise([
      result('a', 'apply', 'apply'),
      result('b', 'apply', 'near_miss'),
      result('c', 'skip', 'skip'),
      result('d', null, 'apply'),
    ]);
    expect(summary).toMatchObject({ labelled: 3, agreed: 2, costPence: 2 });
    expect(summary.agreement).toBeCloseTo(2 / 3);
    expect(summary.confusion.apply.near_miss).toBe(1);
    expect(formatReport(summary, titleSuite())).toContain('Agreement: 66.7% (2/3 labelled cases)');
  });

  it('passes at 80% with every case labelled and no injection miss', () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      result(`g${String(i)}`, 'skip', i < 8 ? 'skip' : 'apply'),
    );
    expect(gate(summarise(results), 10, null, []).ok).toBe(true);
    expect(AGREEMENT_GATE).toBe(0.8);
  });

  it.each([
    ['unlabelled cases', [result('a', null, 'skip')], 1, null, [], /no label yet/],
    ['agreement under 80%', [result('a', 'skip', 'apply')], 1, null, [], /below the 80.0% gate/],
    [
      'a drop below the baseline',
      [
        result('a', 'skip', 'skip'),
        result('b', 'skip', 'skip'),
        result('c', 'skip', 'skip'),
        result('d', 'skip', 'skip'),
        result('e', 'skip', 'apply'),
      ],
      5,
      { agreement: 0.9, labelled: 5, updatedAt: '2026-10-05' },
      [],
      /dropped below the baseline 90.0%/,
    ],
    [
      'an injection case wrong',
      [
        result('a', 'skip', 'apply', true),
        ...Array.from({ length: 9 }, (_, i) => result(`x${String(i)}`, 'skip', 'skip')),
      ],
      10,
      null,
      [],
      /Injection cases wrong: a/,
    ],
    [
      'a title suite failure',
      [result('a', 'skip', 'skip')],
      1,
      null,
      ['Business Analyst'],
      /Title suite failures/,
    ],
  ] as const)('fails on %s', (_name, results, total, baseline, titles, reason) => {
    const verdict = gate(summarise(results), total, baseline, titles);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(reason);
  });

  it('runs the S1 title suite from the shared table at 100%', () => {
    expect(titleSuite().failures).toEqual([]);
  });
});
