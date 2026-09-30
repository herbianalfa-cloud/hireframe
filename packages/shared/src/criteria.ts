import { z } from 'zod';

/**
 * Criteria (PRD R3, docs/FUNNEL.md "Seed criteria", ADR-019).
 * - `criteria/v{n}`: an immutable version. Content keys are snake_case, exactly as in FUNNEL.md.
 * - `criteria/current`: pointer `{ version }` to the version the funnel uses.
 * Both are written by the owner in one batch; firestore.rules enforce the sequence.
 */

const Term = z.string().trim().min(1).max(120);
const TermList = z.array(Term).max(100);

export const ExcludedTitleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/),
  term: Term,
  /** The title is allowed when any of these words appears before `term` (e.g. "Product Manager"). */
  unless_prefixed_by: TermList.exactOptional(),
});
export type ExcludedTitle = z.infer<typeof ExcludedTitleSchema>;

const Score = z.number().min(0).max(10);

export const CriteriaContentSchema = z.object({
  lanes: z.object({
    primary: TermList,
    secondary: TermList,
    opportunistic: TermList,
  }),
  wildcards: TermList,
  excluded_titles: z.array(ExcludedTitleSchema).max(100),
  excluded_keywords: TermList,
  excluded_companies: TermList,
  experience_cap_years: z.int().min(0).max(20),
  blockers: TermList,
  locations: z.object({ preferred: TermList, accepted: TermList }),
  company_prefs: z.object({
    size: z.tuple([z.int().min(1), z.int().min(1)]).refine(([min, max]) => min <= max, {
      message: 'size min must not exceed max',
    }),
    stages: TermList,
    sectors_boost: TermList,
    sectors_penalise: TermList,
  }),
  freshness_days: z.int().min(1).max(90),
  thresholds: z.object({
    apply_fit: Score,
    apply_luck: Score,
    near_miss_fit: Score,
    wildcard_fit: Score,
  }),
  weekly_target: z.int().min(1).max(100),
});
export type CriteriaContent = z.infer<typeof CriteriaContentSchema>;

/** Top-level content keys; firestore.rules checks a written version has exactly these. */
export const CRITERIA_CONTENT_KEYS = Object.keys(
  CriteriaContentSchema.shape,
) as readonly (keyof CriteriaContent)[];

export const CriteriaVersionSchema = CriteriaContentSchema.extend({
  version: z.int().min(1),
  createdAt: z.date(),
  schemaVersion: z.literal(1),
});
export type CriteriaVersion = z.infer<typeof CriteriaVersionSchema>;

export const CriteriaPointerSchema = z.object({
  version: z.int().min(1),
  updatedAt: z.date(),
  schemaVersion: z.literal(1),
});
export type CriteriaPointer = z.infer<typeof CriteriaPointerSchema>;

/** Document ID of criteria version `n` (`v1`, `v2`, …). */
export function criteriaVersionId(version: number): string {
  return `v${String(version)}`;
}
