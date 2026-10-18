import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CV_RUBRIC_VERSION } from '@hireframe/shared';

import { CV_PROMPT_VERSION } from '../applications/prompt.js';
import { DEFAULT_FX_USD_TO_GBP } from '../config.js';
import type { LlmCallDeps } from '../llm/call.js';
import { anthropicTransport } from '../llm/transport.js';
import { eachLimited } from '../sources/types.js';
import { EVAL_NOW, parseGolden } from './cases.js';
import { parseCvCases } from './cv-cases.js';
import { evaluateCvCase, type CvCaseResult } from './cv-evaluate.js';
import {
  canStoreBaseline,
  CvBaselineSchema,
  formatCvReport,
  gateCv,
  summariseCv,
  type CvBaseline,
  type CvBaselineContext,
} from './cv-report.js';
import {
  formatRecordings,
  parseRecordings,
  RecordingMissingError,
  recordingTransport,
  replayTransport,
} from './recordings.js';
import { apiKey, memoryUsage } from './runtime.js';

/**
 * The CV suite of `npm run eval` (CV quality plan §4, ADR-064). Replays `evals/cv-recordings.jsonl`
 * by default (CI, no API key). `LIVE=1 npm run eval -- --suite cv` calls the API through
 * `llm.call()`, spends at most CV_EVAL_CAP_PENCE, and rewrites those recordings only. The rendered
 * files go to `tmp/cv-eval/` (gitignored) so the CVs can be read by eye.
 */
export const CV_FILES = {
  golden: 'evals/golden.jsonl',
  cases: 'evals/cv-cases.jsonl',
  recordings: 'evals/cv-recordings.jsonl',
  baseline: 'evals/cv-baseline.json',
  out: 'tmp/cv-eval',
};
export const CV_EVAL_CAP_PENCE = 200;
const LIVE_CONCURRENCY = 4;

export async function runCvSuite(args: readonly string[], live: boolean): Promise<void> {
  const golden = parseGolden(readFileSync(CV_FILES.golden, 'utf8'));
  const cases = parseCvCases(readFileSync(CV_FILES.cases, 'utf8'), golden);
  const recordings = existsSync(CV_FILES.recordings)
    ? parseRecordings(readFileSync(CV_FILES.recordings, 'utf8'))
    : new Map();
  const baseline: CvBaseline | null = existsSync(CV_FILES.baseline)
    ? CvBaselineSchema.parse(JSON.parse(readFileSync(CV_FILES.baseline, 'utf8')))
    : null;

  const recorder = live ? recordingTransport(anthropicTransport(apiKey())) : null;
  const replay = recorder ? null : replayTransport(recordings);
  const deps: LlmCallDeps = {
    transport: recorder ?? replay ?? replayTransport(recordings),
    usage: memoryUsage(CV_EVAL_CAP_PENCE),
    capPence: CV_EVAL_CAP_PENCE,
    fxUsdToGbp: DEFAULT_FX_USD_TO_GBP,
    now: () => EVAL_NOW,
  };

  mkdirSync(CV_FILES.out, { recursive: true });
  const results: CvCaseResult[] = [];
  const missing: string[] = [];
  await eachLimited(cases, live ? LIVE_CONCURRENCY : 1, async (entry) => {
    try {
      const { result, files } = await evaluateCvCase(entry, golden, deps);
      results.push(result);
      for (const [name, bytes] of Object.entries(files ?? {})) {
        writeFileSync(join(CV_FILES.out, `${entry.id}-${name}`), bytes);
      }
    } catch (error) {
      if (error instanceof RecordingMissingError) missing.push(entry.id);
      else throw error;
    }
  });
  results.sort((a, b) => (a.id < b.id ? -1 : 1));

  if (missing.length > 0) {
    console.error(
      `cv eval: recordings stale for ${missing.join(', ')}. A CV prompt, schema, model or case changed: run \`LIVE=1 npm run eval -- --suite cv\` locally (about 60p, cap ${String(CV_EVAL_CAP_PENCE)}p) and commit evals/cv-recordings.jsonl.`,
    );
    process.exitCode = 1;
    return;
  }
  if (recorder) {
    writeFileSync(CV_FILES.recordings, formatRecordings(recorder.recorded.values()));
    console.log(
      `cv eval: recorded ${String(recorder.recorded.size)} answers to ${CV_FILES.recordings}`,
    );
  }

  console.log(formatCvReport(results));
  if (replay && replay.used.size < recordings.size) {
    console.log(
      `cv eval: ${String(recordings.size - replay.used.size)} of ${String(recordings.size)} recordings unused (a prompt or case change left them behind; re-record to drop them).`,
    );
  }
  const rubric = results.find((r) => r.quality)?.quality?.rubric ?? CV_RUBRIC_VERSION;
  const context: CvBaselineContext = {
    rubric,
    promptVersion: CV_PROMPT_VERSION,
    updating: args.includes('--update-baseline'),
  };
  const verdict = gateCv(results, cases.length, baseline, context);
  if (!verdict.ok) {
    console.error(`\ncv eval: FAILED\n- ${verdict.reasons.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\ncv eval: passed');
  if (args.includes('--update-baseline')) {
    const mean = Number(summariseCv(results).fullMean.toFixed(2));
    const allowed = canStoreBaseline(mean, baseline, context);
    if (!allowed.ok) {
      console.error(`cv eval: baseline not updated. ${allowed.reason}`);
      process.exitCode = 1;
      return;
    }
    const next: CvBaseline = {
      mean,
      cases: cases.length,
      rubric: context.rubric,
      promptVersion: context.promptVersion,
      updatedAt: new Date().toISOString().slice(0, 10),
    };
    writeFileSync(CV_FILES.baseline, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`cv eval: baseline set to ${next.mean.toFixed(2)}`);
  }
}
