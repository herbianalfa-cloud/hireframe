import type { CriteriaContent, ExcludedTitle } from './criteria.js';

/**
 * Excluded-title rules (docs/FUNNEL.md "Seed criteria", ADR-020). Pure, so the S1 rules (M4)
 * and the seed tests apply exactly the same semantics:
 * - Titles and terms are compared as whole words, case-insensitively; anything that isn't a
 *   letter or digit separates words ("Support / Business Analyst" → support, business, analyst).
 * - A rule matches wherever its term's words appear consecutively in the title. That occurrence
 *   is allowed when the word(s) immediately before it are one of `unless_prefixed_by`.
 *   Any occurrence that isn't allowed excludes the title.
 * - Lanes win: a title containing a lane title is not excluded by a non-seniority rule (e.g.
 *   "Junior Brand Manager"). Seniority rules always apply ("Senior Product Analyst").
 */

/** Rules a lane title never overrides. Matched by rule ID, so renaming a term keeps it. */
export const SENIORITY_TITLE_IDS: readonly string[] = [
  'senior',
  'lead',
  'principal',
  'head-of',
  'director',
];

export type Lane = keyof CriteriaContent['lanes'];

export interface TitleCheck {
  /** The ID of the rule that excludes the title, or null. */
  excludedBy: string | null;
  /** The first lane whose title the job title contains, or null. */
  lane: Lane | null;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
}

function occurrences(title: readonly string[], term: readonly string[]): number[] {
  const found: number[] = [];
  if (term.length === 0) return found;
  for (let at = 0; at + term.length <= title.length; at++) {
    if (term.every((word, i) => title[at + i] === word)) found.push(at);
  }
  return found;
}

function prefixedBy(title: readonly string[], at: number, prefix: readonly string[]): boolean {
  return (
    prefix.length > 0 &&
    prefix.length <= at &&
    prefix.every((word, i) => title[at - prefix.length + i] === word)
  );
}

export function matchesExcludedTitle(title: string, rule: ExcludedTitle): boolean {
  const titleWords = words(title);
  const prefixes = (rule.unless_prefixed_by ?? []).map(words);
  return occurrences(titleWords, words(rule.term)).some(
    (at) => !prefixes.some((prefix) => prefixedBy(titleWords, at, prefix)),
  );
}

/** "Junior/Graduate/Associate Business Analyst" → one title per alternative. */
export function laneTitleVariants(laneTitle: string): string[] {
  return laneTitle
    .trim()
    .split(/\s+/)
    .reduce<string[]>(
      (variants, token) =>
        token
          .split('/')
          .filter((alternative) => alternative !== '')
          .flatMap((alternative) => variants.map((variant) => `${variant} ${alternative}`.trim())),
      [''],
    );
}

export function laneOf(title: string, lanes: CriteriaContent['lanes']): Lane | null {
  const titleWords = words(title);
  for (const lane of ['primary', 'secondary', 'opportunistic'] as const) {
    const hit = lanes[lane]
      .flatMap(laneTitleVariants)
      .some((variant) => occurrences(titleWords, words(variant)).length > 0);
    if (hit) return lane;
  }
  return null;
}

export function checkTitle(
  title: string,
  criteria: Pick<CriteriaContent, 'lanes' | 'excluded_titles'>,
  /** Rules a lane title never overrides; the diagnostics add a candidate's ID to try it out. */
  seniorityIds: readonly string[] = SENIORITY_TITLE_IDS,
): TitleCheck {
  const lane = laneOf(title, criteria.lanes);
  for (const rule of criteria.excluded_titles) {
    if (!matchesExcludedTitle(title, rule)) continue;
    if (lane !== null && !seniorityIds.includes(rule.id)) continue;
    return { excludedBy: rule.id, lane };
  }
  return { excludedBy: null, lane };
}
