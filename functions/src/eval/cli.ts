import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { DEFAULT_FX_USD_TO_GBP } from '../config.js';
import type { LlmCallDeps } from '../llm/call.js';
import { anthropicTransport } from '../llm/transport.js';
import { applyReserve, applySettle, emptyUsage, type UsageStore } from '../llm/usage-store.js';
import { setLogSink } from '../log.js';
import { eachLimited } from '../sources/types.js';
import { EVAL_NOW, parseGolden } from './cases.js';
import { evaluateCase, titleSuite, type CaseResult } from './evaluate.js';
import {
  formatRecordings,
  parseRecordings,
  RecordingMissingError,
  recordingTransport,
  replayTransport,
} from './recordings.js';
import { BaselineSchema, formatReport, gate, summarise, type Baseline } from './report.js';

/**
 * `npm run eval` (ADR-036). Replays `evals/recordings.jsonl` by default, which is what CI runs:
 * no Anthropic key needed. `LIVE=1 npm run eval` calls the API (key from ANTHROPIC_API_KEY or
 * functions/.secret.local), spends at most EVAL_CAP_PENCE through `llm.call()`, and rewrites the
 * recordings. `--update-baseline` stores the agreement as the new floor once the gate passes.
 */
const FILES = {
  golden: 'evals/golden.jsonl',
  recordings: 'evals/recordings.jsonl',
  baseline: 'evals/baseline.json',
  secrets: 'functions/.secret.local',
};
const EVAL_CAP_PENCE = 150;
const LIVE_CONCURRENCY = 4;

function memoryUsage(): UsageStore {
  let usage = emptyUsage(EVAL_CAP_PENCE, EVAL_NOW);
  return {
    reserve(input) {
      usage = applyReserve(usage, input);
      return Promise.resolve();
    },
    settle(input) {
      usage = applySettle(usage, input);
      return Promise.resolve();
    },
  };
}

function apiKey(): string {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(FILES.secrets)) {
    const line = readFileSync(FILES.secrets, 'utf8')
      .split(/\r?\n/)
      .find((entry) => entry.startsWith('ANTHROPIC_API_KEY='));
    const key = line?.slice('ANTHROPIC_API_KEY='.length).trim();
    if (key) return key;
  }
  throw new Error(`LIVE=1 needs ANTHROPIC_API_KEY in the environment or in ${FILES.secrets}.`);
}

export async function main(args: readonly string[]): Promise<void> {
  // llm.call() logs every call; the report says what matters.
  setLogSink(() => undefined);
  const live = process.env.LIVE === '1';
  const cases = parseGolden(readFileSync(FILES.golden, 'utf8'));
  const recordings = existsSync(FILES.recordings)
    ? parseRecordings(readFileSync(FILES.recordings, 'utf8'))
    : new Map();
  const baseline: Baseline | null = existsSync(FILES.baseline)
    ? BaselineSchema.parse(JSON.parse(readFileSync(FILES.baseline, 'utf8')))
    : null;

  const replay = replayTransport(recordings);
  const recorder = live ? recordingTransport(anthropicTransport(apiKey())) : null;
  const deps: LlmCallDeps = {
    transport: recorder ?? replay,
    usage: memoryUsage(),
    capPence: EVAL_CAP_PENCE,
    fxUsdToGbp: DEFAULT_FX_USD_TO_GBP,
    now: () => EVAL_NOW,
  };

  const results: CaseResult[] = [];
  const missing: string[] = [];
  await eachLimited(cases, live ? LIVE_CONCURRENCY : 1, async (entry) => {
    try {
      results.push(await evaluateCase(entry, deps));
    } catch (error) {
      if (error instanceof RecordingMissingError) missing.push(entry.id);
      else throw error;
    }
  });
  results.sort((a, b) => (a.id < b.id ? -1 : 1));

  if (missing.length > 0) {
    console.error(
      `eval: recordings stale for ${missing.join(', ')}. A prompt, schema, model or case changed: run \`LIVE=1 npm run eval\` locally (about £0.40) and commit evals/recordings.jsonl.`,
    );
    process.exitCode = 1;
    return;
  }
  if (recorder) {
    writeFileSync(FILES.recordings, formatRecordings(recorder.recorded.values()));
    console.log(`eval: recorded ${String(recorder.recorded.size)} answers to ${FILES.recordings}`);
  }

  const summary = summarise(results);
  const titles = titleSuite();
  console.log(formatReport(summary, titles));
  const verdict = gate(summary, cases.length, baseline, titles.failures);
  if (!verdict.ok) {
    console.error(`\neval: FAILED\n- ${verdict.reasons.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\neval: passed');
  if (args.includes('--update-baseline')) {
    const next: Baseline = {
      agreement: summary.agreement,
      labelled: summary.labelled,
      updatedAt: new Date().toISOString().slice(0, 10),
    };
    writeFileSync(FILES.baseline, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`eval: baseline set to ${(summary.agreement * 100).toFixed(1)}%`);
  }
}
