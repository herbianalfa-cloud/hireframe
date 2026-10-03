import type { Fact } from './profile.js';
import { workRightsLine, type WorkRightsSetting } from './profile.js';

/**
 * How the funnel prompts describe the candidate (docs/FUNNEL.md "S2", "S3"). Built in code from
 * the active facts, with no model call, and deterministic: the same facts always give the same
 * text, so the S3 system prompt stays cacheable and re-score fingerprints stay stable.
 */

export type FunnelFact = Pick<Fact, 'type' | 'text' | 'dates' | 'lanes'> & { id: string };

/** Longest candidate summary S2 gets (FUNNEL.md asks for about 200 words). */
export const SUMMARY_MAX_CHARS = 1_600;

/** Code-unit order, so the text never depends on the runtime's locale. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Facts in a stable order: newest first by start date, then by ID. */
function ordered(facts: readonly FunnelFact[]): FunnelFact[] {
  return [...facts].sort((a, b) => {
    const byDate = compareIds(b.dates.start ?? '', a.dates.start ?? '');
    return byDate !== 0 ? byDate : compareIds(a.id, b.id);
  });
}

function section(label: string, texts: readonly string[], max: number, separator = '; '): string {
  if (texts.length === 0) return '';
  const shown = texts.slice(0, max).map((text) => text.replace(/\s+/g, ' ').trim());
  return `${label}: ${shown.join(separator)}.`;
}

/** The S2 candidate summary: education, experience, highlights, skills, constraints, work rights. */
export function candidateSummary(
  facts: readonly FunnelFact[],
  workRights: WorkRightsSetting | null,
): string {
  const of = (type: FunnelFact['type']) =>
    ordered(facts.filter((fact) => fact.type === type)).map((fact) => fact.text);
  const lines = [
    section('Education', of('education'), 3),
    section('Experience', of('experience'), 6),
    section('Highlights', [...of('metric'), ...of('achievement')], 5),
    section('Projects', of('project'), 4),
    section('Skills', of('skill'), 25, ', '),
    section('Constraints', of('constraint'), 4),
    section('Preferences', of('preference'), 3),
  ].filter((line) => line !== '');
  const rights = workRightsLine(workRights);
  let summary = '';
  for (const line of lines) {
    const next = summary === '' ? line : `${summary}\n${line}`;
    if (next.length + rights.length + 1 > SUMMARY_MAX_CHARS) break;
    summary = next;
  }
  return summary === '' ? rights : `${summary}\n${rights}`;
}

/** The S3 facts block: one `[F12] type: text` line per fact, in alias order. */
export function factsBlock(
  facts: readonly FunnelFact[],
  toAlias: ReadonlyMap<string, string>,
): string {
  return [...facts]
    .filter((fact) => toAlias.has(fact.id))
    .sort((a, b) => compareIds(a.id, b.id))
    .map(
      (fact) => `[${toAlias.get(fact.id) ?? ''}] ${fact.type}: ${fact.text.replace(/\s+/g, ' ')}`,
    )
    .join('\n');
}
