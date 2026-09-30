import type { CriteriaContent } from '@hireframe/shared';

/**
 * The criteria form's working copy. Numbers are strings so a field can be empty or half-typed,
 * and excluded titles carry a local `key` for React plus the stored `id` (undefined for new rows).
 */
export interface TitleRow {
  key: string;
  id: string | undefined;
  term: string;
  prefixes: string[];
}

export interface Draft {
  lanes: { primary: string[]; secondary: string[]; opportunistic: string[] };
  wildcards: string[];
  excludedTitles: TitleRow[];
  excludedKeywords: string[];
  excludedCompanies: string[];
  blockers: string[];
  experienceCapYears: string;
  locations: { preferred: string[]; accepted: string[] };
  sizeMin: string;
  sizeMax: string;
  stages: string[];
  sectorsBoost: string[];
  sectorsPenalise: string[];
  freshnessDays: string;
  thresholds: { applyFit: string; applyLuck: string; nearMissFit: string; wildcardFit: string };
  weeklyTarget: string;
}

let rowCounter = 0;
export function newRowKey(): string {
  rowCounter += 1;
  return `title-row-${String(rowCounter)}`;
}

export function toDraft(content: CriteriaContent): Draft {
  return {
    lanes: {
      primary: [...content.lanes.primary],
      secondary: [...content.lanes.secondary],
      opportunistic: [...content.lanes.opportunistic],
    },
    wildcards: [...content.wildcards],
    excludedTitles: content.excluded_titles.map((title) => ({
      key: newRowKey(),
      id: title.id,
      term: title.term,
      prefixes: [...(title.unless_prefixed_by ?? [])],
    })),
    excludedKeywords: [...content.excluded_keywords],
    excludedCompanies: [...content.excluded_companies],
    blockers: [...content.blockers],
    experienceCapYears: String(content.experience_cap_years),
    locations: {
      preferred: [...content.locations.preferred],
      accepted: [...content.locations.accepted],
    },
    sizeMin: String(content.company_prefs.size[0]),
    sizeMax: String(content.company_prefs.size[1]),
    stages: [...content.company_prefs.stages],
    sectorsBoost: [...content.company_prefs.sectors_boost],
    sectorsPenalise: [...content.company_prefs.sectors_penalise],
    freshnessDays: String(content.freshness_days),
    thresholds: {
      applyFit: String(content.thresholds.apply_fit),
      applyLuck: String(content.thresholds.apply_luck),
      nearMissFit: String(content.thresholds.near_miss_fit),
      wildcardFit: String(content.thresholds.wildcard_fit),
    },
    weeklyTarget: String(content.weekly_target),
  };
}

/** Blank or unparseable input becomes NaN, which the schema rejects. */
function num(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

/** A slug for a new excluded title: lower-case words joined by "-", unique among `used`. */
export function slugify(term: string, used: ReadonlySet<string>): string {
  const base =
    term
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/, '') || 'title';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${String(n)}`;
  return id;
}

/** The draft as criteria content, ready for CriteriaContentSchema. Never contains `undefined`. */
export function toContent(draft: Draft): CriteriaContent {
  const used = new Set<string>();
  for (const row of draft.excludedTitles) if (row.id) used.add(row.id);
  return {
    lanes: draft.lanes,
    wildcards: draft.wildcards,
    excluded_titles: draft.excludedTitles.map((row) => {
      const id = row.id ?? slugify(row.term, used);
      used.add(id);
      return {
        id,
        term: row.term,
        ...(row.prefixes.length > 0 ? { unless_prefixed_by: row.prefixes } : {}),
      };
    }),
    excluded_keywords: draft.excludedKeywords,
    excluded_companies: draft.excludedCompanies,
    experience_cap_years: num(draft.experienceCapYears),
    blockers: draft.blockers,
    locations: draft.locations,
    company_prefs: {
      size: [num(draft.sizeMin), num(draft.sizeMax)],
      stages: draft.stages,
      sectors_boost: draft.sectorsBoost,
      sectors_penalise: draft.sectorsPenalise,
    },
    freshness_days: num(draft.freshnessDays),
    thresholds: {
      apply_fit: num(draft.thresholds.applyFit),
      apply_luck: num(draft.thresholds.applyLuck),
      near_miss_fit: num(draft.thresholds.nearMissFit),
      wildcard_fit: num(draft.thresholds.wildcardFit),
    },
    weekly_target: num(draft.weeklyTarget),
  };
}

/** Field messages for the numeric inputs, keyed by schema path prefix. */
const NUMBER_MESSAGES: readonly (readonly [string, string])[] = [
  ['experience_cap_years', 'Enter a whole number from 0 to 20.'],
  ['company_prefs.size', 'Enter sizes of 1 or more, with the minimum no larger than the maximum.'],
  ['freshness_days', 'Enter a whole number of days from 1 to 90.'],
  ['thresholds', 'Enter a score from 0 to 10.'],
  ['weekly_target', 'Enter a whole number from 1 to 100.'],
];

/** Issue paths joined with "." mapped to a message. */
export function toFieldErrors(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const path = issue.path.map(String).join('.');
    const custom = NUMBER_MESSAGES.find(
      ([prefix]) => path === prefix || path.startsWith(`${prefix}.`),
    );
    errors[path] ??= custom ? custom[1] : issue.message;
  }
  return errors;
}

/** The first error at `path` or below it. */
export function errorAt(errors: Record<string, string>, path: string): string | undefined {
  for (const [key, message] of Object.entries(errors)) {
    if (key === path || key.startsWith(`${path}.`)) return message;
  }
  return undefined;
}
