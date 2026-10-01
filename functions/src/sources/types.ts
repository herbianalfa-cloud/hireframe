import type { Ats, CriteriaContent, RawJob, ScanSourceId, SourceStatus } from '@hireframe/shared';

import type { HttpClient } from '../http/client.js';

/**
 * The source module contract (docs/ARCHITECTURE.md "Sources", ADR-029):
 * `interface Source { id; fetch(ctx): Promise<RawJob[]>; health(): SourceHealth }`.
 * A source is created fresh for each run, so `health()` describes this run. A failed board or
 * query is recorded in `health()` (status `degraded`, or `failing` when nothing worked); `fetch`
 * only throws for a bug or a failure outside any one request, which the scan records as failing.
 */

export interface WatchedCompany {
  id: string;
  name: string;
  ats: Ats;
}

export interface BoardResult {
  companyId: string;
  status: 'ok' | 'not_found' | 'error';
  jobs: number;
  errorCode?: string;
}

export interface SourceSecrets {
  reedApiKey?: string;
  adzunaAppId?: string;
  adzunaAppKey?: string;
}

export interface SourceContext {
  /** This source's own client (its request count is this source's). */
  http: HttpClient;
  /** Watched companies (ATS sources use those of their type). */
  companies: readonly WatchedCompany[];
  /** Current criteria, for query-driven sources (Reed, Adzuna). Null before criteria exist. */
  criteria: CriteriaContent | null;
  now: Date;
  secrets: SourceSecrets;
  /** API calls this source may make this run (quota-limited sources). */
  callBudget: number;
  /** Where query rotation continues (quota-limited sources). */
  queryCursor: number;
}

export interface SourceReport {
  status: SourceStatus;
  /** Postings returned (valid or not). */
  fetched: number;
  /** Postings that failed the source's item schema. */
  invalid: number;
  /** Failed boards, queries or pages. */
  errors: number;
  errorCode?: string;
  boards: BoardResult[];
  /** Quota-limited sources: calls made and where rotation continues next run. */
  callsUsed?: number;
  nextQueryCursor?: number;
}

export interface Source {
  id: ScanSourceId;
  fetch(ctx: SourceContext): Promise<RawJob[]>;
  health(): SourceReport;
}

export function emptyReport(status: SourceStatus = 'ok'): SourceReport {
  return { status, fetched: 0, invalid: 0, errors: 0, boards: [] };
}

/** ok when nothing failed; failing when nothing succeeded; degraded in between. */
export function statusFrom(attempts: number, failures: number): SourceStatus {
  if (attempts === 0) return 'skipped';
  if (failures === 0) return 'ok';
  return failures >= attempts ? 'failing' : 'degraded';
}

/** Runs `task` over `items` with at most `limit` in flight, in order of start. */
export async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await task(item);
    }
  });
  await Promise.all(workers);
}

/** A date from an API string or epoch ms; undefined when missing or unparseable. */
export function parseDate(value: string | number | null | undefined): Date | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
