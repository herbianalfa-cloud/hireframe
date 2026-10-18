import { APPLICATION_LIMITS, CV_SCORE_TARGET } from '@hireframe/shared';
import { z } from 'zod';

import { JUDGE_ITEMS } from './cv-judge.js';
import type { CvCaseResult } from './cv-evaluate.js';

/** The CV eval's report and gates (CV quality plan §4, ADR-064). */
export const CV_MEAN_GATE = 8.3;
/** The mean may sit this far under the baseline before the gate fails. */
export const CV_BASELINE_SLACK = 0.2;
/** Full-profile cases that must reach the score target. */
export const CV_MIN_PASSING = 6;

export const CvBaselineSchema = z.object({
  /** Mean final score of the full-profile cases. */
  mean: z.number().min(0).max(10),
  cases: z.int().min(1),
  updatedAt: z.string(),
});
export type CvBaseline = z.infer<typeof CvBaselineSchema>;

export interface CvSummary {
  cases: number;
  full: number;
  /** Full-profile cases at or over the score target. */
  passing: number;
  fullMean: number;
  revisions: number;
  revisionRate: number;
  costPence: number;
  judgeCostPence: number;
  /** Mean cost of one CV: write plus revision. */
  costPerCvPence: number;
  tokens: { input: number; output: number };
  judgeMeans: Record<(typeof JUDGE_ITEMS)[number], number> | null;
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

export function summariseCv(results: readonly CvCaseResult[]): CvSummary {
  const full = results.filter((r) => r.profile === 'full');
  const totals = full.map((r) => r.quality?.total ?? 0);
  const judged = results.flatMap((r) => (r.judge ? [r.judge] : []));
  const revisions = results.filter((r) => r.reviseCalls > 0).length;
  return {
    cases: results.length,
    full: full.length,
    passing: totals.filter((total) => total >= CV_SCORE_TARGET).length,
    fullMean: mean(totals),
    revisions,
    revisionRate: results.length === 0 ? 0 : revisions / results.length,
    costPence: results.reduce((sum, r) => sum + r.costPence, 0),
    judgeCostPence: results.reduce((sum, r) => sum + r.judgeCostPence, 0),
    costPerCvPence: mean(results.map((r) => r.costPence)),
    tokens: {
      input: results.reduce((sum, r) => sum + r.cvTokens.input, 0),
      output: results.reduce((sum, r) => sum + r.cvTokens.output, 0),
    },
    judgeMeans:
      judged.length === 0
        ? null
        : (Object.fromEntries(
            JUDGE_ITEMS.map((item) => [item, mean(judged.map((j) => j[item]))]),
          ) as CvSummary['judgeMeans']),
  };
}

export interface CvGateResult {
  ok: boolean;
  reasons: string[];
}

/**
 * The gate. The judge is report-only and never enters it. A case that failed to ship fails the
 * "every case" checks and is left out of the means. The thin profile has no score or revision
 * rule: it passes by shipping a valid one-page CV within the call limit (it is not a full case).
 */
export function gateCv(
  results: readonly CvCaseResult[],
  expectedCases: number,
  baseline: CvBaseline | null,
): CvGateResult {
  const reasons: string[] = [];
  if (results.length !== expectedCases) {
    reasons.push(`${String(results.length)} of ${String(expectedCases)} cases ran.`);
  }
  for (const r of results) {
    const problems: string[] = [];
    if (!r.shipped) problems.push(`no CV shipped (${r.failure ?? 'unknown'})`);
    else {
      if (r.pages !== 1) problems.push(`CV is ${String(r.pages)} pages`);
      if (r.notePages !== 1) problems.push(`note is ${String(r.notePages)} pages`);
      if (!r.textsMatch) problems.push('PDF and DOCX text differ');
      if (r.revisionSkipped === 'error' || r.revisionSkipped === 'cap') {
        problems.push(`revision skipped (${r.revisionSkipped})`);
      }
      if (r.hard > 0) problems.push(`${String(r.hard)} hard finding(s)`);
      if (r.emDash) problems.push('em dash in a file');
      if (r.markerLeaked) problems.push('the injection marker is in a file');
    }
    if (r.writeCalls + r.reviseCalls > APPLICATION_LIMITS.maxAttempts) {
      problems.push(`${String(r.writeCalls + r.reviseCalls)} model calls`);
    }
    if (problems.length > 0) reasons.push(`${r.id}: ${problems.join('; ')}.`);
  }
  const summary = summariseCv(results);
  if (summary.passing < CV_MIN_PASSING) {
    reasons.push(
      `Only ${String(summary.passing)} of ${String(summary.full)} full-profile cases reach ${String(CV_SCORE_TARGET)} (need ${String(CV_MIN_PASSING)}).`,
    );
  }
  if (summary.fullMean < CV_MEAN_GATE) {
    reasons.push(`Mean ${num(summary.fullMean)} is below ${String(CV_MEAN_GATE)}.`);
  }
  if (baseline && summary.fullMean < baseline.mean - CV_BASELINE_SLACK - 1e-9) {
    reasons.push(
      `Mean ${num(summary.fullMean)} is more than ${String(CV_BASELINE_SLACK)} under the baseline ${num(baseline.mean)}.`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}

const num = (value: number): string => value.toFixed(2);

/** One line per case with a write that did not validate: which write, and why. */
function writeIssueLines(results: readonly CvCaseResult[]): string[] {
  const lines = results.flatMap((r) => {
    if (!r.writeIssues.some((codes) => codes.length > 0)) return [];
    const writes = r.writeIssues.map(
      (codes, i) => `write ${String(i + 1)} ${codes.length === 0 ? 'valid' : codes.join(', ')}`,
    );
    return [`${r.id}: ${writes.join('; ')}`];
  });
  return lines.length === 0
    ? []
    : ['Writes that failed validation:', ...lines.map((l) => `  ${l}`), ''];
}

/** The skills removed before validating, per case: uncited, or citing a fact that is no skill. */
function skillsDroppedLines(results: readonly CvCaseResult[]): string[] {
  const dropped = results.filter((r) => r.skillsDropped > 0);
  if (dropped.length === 0) return [];
  const total = dropped.reduce((sum, r) => sum + r.skillsDropped, 0);
  return [
    `Skills dropped before validating (${String(total)}): ${dropped
      .map((r) => `${r.id} ${String(r.skillsDropped)}`)
      .join(', ')}`,
    '',
  ];
}

export function formatCvReport(results: readonly CvCaseResult[]): string {
  const summary = summariseCv(results);
  const rows = results.map((r) => {
    const q = r.quality;
    const revision = r.reviseCalls > 0 ? 'used' : (q?.revisionSkipped ?? (q ? 'not needed' : '-'));
    const judge = r.judge
      ? JUDGE_ITEMS.map((item) => String(r.judge?.[item] ?? '-')).join('/')
      : '-';
    return [
      r.id,
      r.profile,
      r.firstWriteValid ? 'yes' : 'no',
      q?.draftTotal === undefined ? (q ? num(q.total) : '-') : num(q.draftTotal),
      q ? num(q.total) : '-',
      revision,
      `${String(r.writeCalls)}+${String(r.reviseCalls)}`,
      q ? `${(q.layout.fill * 100).toFixed(0)}%@${String(q.layout.bodySize)}` : '-',
      r.draftHard === undefined ? '-' : `${String(r.draftHard)}/${String(r.draftSoft ?? 0)}`,
      `${String(r.hard)}/${String(r.soft)}`,
      `${r.costPence.toFixed(1)}p`,
      judge,
    ];
  });
  const head = [
    'case',
    'profile',
    '1st ok',
    'draft',
    'final',
    'revision',
    'calls',
    'fill',
    'draft h/s',
    'hard/soft',
    'cost',
    'judge g/p/t/n',
  ];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]?.length ?? 0)));
  const line = (row: readonly string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ');
  const lines = [
    line(head),
    ...rows.map(line),
    '',
    ...writeIssueLines(results),
    ...skillsDroppedLines(results),
    `Full profile: ${String(summary.passing)}/${String(summary.full)} at ${String(CV_SCORE_TARGET)} or more · mean ${num(summary.fullMean)}`,
    `Revisions: ${String(summary.revisions)}/${String(summary.cases)} (${(summary.revisionRate * 100).toFixed(0)}%)`,
    `Tokens (write + revision): ${String(summary.tokens.input)} in, ${String(summary.tokens.output)} out`,
    `Cost: ${summary.costPence.toFixed(2)}p for the CVs (${summary.costPerCvPence.toFixed(2)}p each), ${summary.judgeCostPence.toFixed(2)}p for the judge`,
  ];
  if (summary.judgeMeans) {
    lines.push(
      `Judge means (report only): ${JUDGE_ITEMS.map((item) => `${item} ${num(summary.judgeMeans?.[item] ?? 0)}`).join(' · ')}`,
    );
  }
  return lines.join('\n');
}
