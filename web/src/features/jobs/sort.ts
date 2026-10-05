import type { GapType, TriageLane } from '@hireframe/shared';

import type { JobView } from '@/services/job-read';

/** Sorts and filters for job lists. Pure: they run in the browser on rows already loaded (ADR-044). */
export const JOB_SORTS = ['best', 'fit', 'luck', 'newest'] as const;
export type JobSort = (typeof JOB_SORTS)[number];

export const SORT_LABELS: Readonly<Record<JobSort, string>> = {
  best: 'Best overall',
  fit: 'Fit',
  luck: 'Luck',
  newest: 'Newest',
};

export const isJobSort = (value: string | null | undefined): value is JobSort =>
  value !== null && value !== undefined && (JOB_SORTS as readonly string[]).includes(value);

/** The lanes worth filtering on; wildcard has its own verdict list and `none` never reaches one. */
export const LANE_FILTERS = [
  'primary',
  'secondary',
  'opportunistic',
] as const satisfies readonly TriageLane[];
export type LaneFilter = (typeof LANE_FILTERS)[number];

export const LANE_LABELS: Readonly<Record<LaneFilter, string>> = {
  primary: 'Primary',
  secondary: 'Secondary',
  opportunistic: 'Opportunistic',
};

export const isLaneFilter = (value: string | null | undefined): value is LaneFilter =>
  value !== null && value !== undefined && (LANE_FILTERS as readonly string[]).includes(value);

const GAP_TYPE_FILTERS = ['tool', 'domain', 'seniority'] as const satisfies readonly GapType[];
export const GAP_FILTERS = [...GAP_TYPE_FILTERS, 'tool-only'] as const;
export type GapFilter = (typeof GAP_FILTERS)[number];

export const GAP_LABELS: Readonly<Record<GapFilter, string>> = {
  tool: 'Tool',
  domain: 'Domain',
  seniority: 'Seniority',
  'tool-only': 'Tool only',
};

export const isGapFilter = (value: string | null | undefined): value is GapFilter =>
  value !== null && value !== undefined && (GAP_FILTERS as readonly string[]).includes(value);

export interface JobFilter {
  lane?: LaneFilter | undefined;
  gap?: GapFilter | undefined;
}

const judgedMs = (view: JobView): number => view.job.judgedAt?.getTime() ?? 0;

/** Larger first; a missing score sorts after every real one, even 0. */
function byScore(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return b - a;
}

function combined(view: JobView): number | undefined {
  const { fitScore, luckScore } = view.job;
  return fitScore === undefined || luckScore === undefined ? undefined : fitScore + luckScore;
}

type Compare = (a: JobView, b: JobView) => number;

const COMPARES: Readonly<Record<JobSort, Compare>> = {
  best: (a, b) =>
    byScore(combined(a), combined(b)) ||
    byScore(a.job.fitScore, b.job.fitScore) ||
    judgedMs(b) - judgedMs(a),
  fit: (a, b) =>
    byScore(a.job.fitScore, b.job.fitScore) ||
    byScore(a.job.luckScore, b.job.luckScore) ||
    judgedMs(b) - judgedMs(a),
  luck: (a, b) =>
    byScore(a.job.luckScore, b.job.luckScore) ||
    byScore(a.job.fitScore, b.job.fitScore) ||
    judgedMs(b) - judgedMs(a),
  newest: (a, b) => judgedMs(b) - judgedMs(a),
};

/** A new array in the chosen order. Ties end on id, so the order never depends on input order. */
export function sortJobs(views: readonly JobView[], sort: JobSort): JobView[] {
  const compare = COMPARES[sort];
  return [...views].sort((a, b) => compare(a, b) || a.id.localeCompare(b.id));
}

function matchesGap(view: JobView, gap: GapFilter): boolean {
  const gaps = view.job.gaps ?? [];
  if (gaps.length === 0) return false;
  if (gap === 'tool-only') return gaps.every((item) => item.type === 'tool');
  return gaps.some((item) => item.type === gap);
}

export function filterJobs(views: readonly JobView[], filter: JobFilter): JobView[] {
  const { lane, gap } = filter;
  if (!lane && !gap) return [...views];
  return views.filter(
    (view) => (!lane || view.job.triage?.lane === lane) && (!gap || matchesGap(view, gap)),
  );
}
