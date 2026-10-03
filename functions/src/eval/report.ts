import { VERDICTS, type Verdict } from '@hireframe/shared';
import { z } from 'zod';

import type { CaseResult, EvalVerdict } from './evaluate.js';

/** The eval report and its gates (FUNNEL.md "Evals", ADR-036). */
export const AGREEMENT_GATE = 0.8;

export const BaselineSchema = z.object({
  agreement: z.number().min(0).max(1),
  labelled: z.int().min(0),
  updatedAt: z.string(),
});
export type Baseline = z.infer<typeof BaselineSchema>;

export interface Summary {
  labelled: number;
  agreed: number;
  agreement: number;
  /** confusion[label][verdict] */
  confusion: Record<Verdict, Record<EvalVerdict, number>>;
  byStage: Record<'s1' | 's2' | 's3', number>;
  costPence: number;
  drift: number;
  injectionFailures: string[];
  disagreements: CaseResult[];
}

const COLUMNS: readonly EvalVerdict[] = [...VERDICTS, 'review'];

export function summarise(results: readonly CaseResult[]): Summary {
  const confusion = Object.fromEntries(
    VERDICTS.map((label) => [label, Object.fromEntries(COLUMNS.map((v) => [v, 0]))]),
  ) as Summary['confusion'];
  const byStage = { s1: 0, s2: 0, s3: 0 };
  const labelled = results.filter((r): r is CaseResult & { label: Verdict } => r.label !== null);
  for (const result of labelled) confusion[result.label][result.verdict] += 1;
  for (const result of results) byStage[result.stage] += 1;
  const disagreements = labelled.filter((r) => r.verdict !== r.label);
  return {
    labelled: labelled.length,
    agreed: labelled.length - disagreements.length,
    agreement:
      labelled.length === 0 ? 0 : (labelled.length - disagreements.length) / labelled.length,
    confusion,
    byStage,
    costPence: results.reduce((sum, r) => sum + r.costPence, 0),
    drift: results.filter((r) => r.drift).length,
    injectionFailures: labelled
      .filter((r) => r.injection && r.verdict !== r.label)
      .map((r) => r.id),
    disagreements,
  };
}

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

export function gate(
  summary: Summary,
  total: number,
  baseline: Baseline | null,
  titleFailures: readonly string[],
): GateResult {
  const reasons: string[] = [];
  if (summary.labelled < total) {
    reasons.push(
      `${String(total - summary.labelled)} of ${String(total)} cases have no label yet (node scripts/eval-labels.ts export).`,
    );
  }
  if (summary.agreement < AGREEMENT_GATE) {
    reasons.push(`Agreement ${pct(summary.agreement)} is below the ${pct(AGREEMENT_GATE)} gate.`);
  }
  if (baseline && summary.agreement < baseline.agreement - 1e-9) {
    reasons.push(
      `Agreement ${pct(summary.agreement)} dropped below the baseline ${pct(baseline.agreement)}.`,
    );
  }
  if (summary.injectionFailures.length > 0) {
    reasons.push(`Injection cases wrong: ${summary.injectionFailures.join(', ')}.`);
  }
  if (titleFailures.length > 0) {
    reasons.push(`Title suite failures: ${titleFailures.join('; ')}.`);
  }
  return { ok: reasons.length === 0, reasons };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatReport(
  summary: Summary,
  titles: { total: number; failures: string[] },
): string {
  const header = `label \\ verdict  ${COLUMNS.map((c) => c.padStart(9)).join('')}`;
  const rows = VERDICTS.map(
    (label) =>
      `${label.padEnd(16)} ${COLUMNS.map((c) => String(summary.confusion[label][c]).padStart(9)).join('')}`,
  );
  const lines = [
    `Agreement: ${pct(summary.agreement)} (${String(summary.agreed)}/${String(summary.labelled)} labelled cases)`,
    '',
    header,
    ...rows,
    '',
    `Stopped at: S1 ${String(summary.byStage.s1)} · S2 ${String(summary.byStage.s2)} · S3 ${String(summary.byStage.s3)}`,
    `Cost: ${summary.costPence.toFixed(2)}p · score drift > 2: ${String(summary.drift)}`,
    `Title suite (S1): ${String(titles.total - titles.failures.length)}/${String(titles.total)}`,
  ];
  if (summary.disagreements.length > 0) {
    lines.push('', 'Disagreements:');
    for (const r of summary.disagreements) {
      const where = r.stage === 's1' ? `S1 ${r.ruleId ?? ''}` : r.stage.toUpperCase();
      const scores = r.fit === undefined ? '' : ` fit ${String(r.fit)} luck ${String(r.luck)}`;
      lines.push(`  ${r.id}: label ${String(r.label)}, got ${r.verdict} at ${where}${scores}`);
    }
  }
  return lines.join('\n');
}
