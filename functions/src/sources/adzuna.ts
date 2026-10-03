import { htmlToText, type RawJob, type Salary } from '@hireframe/shared';
import { z } from 'zod';

import { SOURCE_QUERIES } from '../config.js';
import { HttpError } from '../http/client.js';
import { optionalText } from './ats.js';
import { planQueries } from './queries.js';
import {
  emptyReport,
  parseDate,
  statusFrom,
  type Source,
  type SourceContext,
  type SourceReport,
} from './types.js';

/**
 * Adzuna API (keyed; ADR-025): `api.adzuna.com/v1/api/jobs/gb/search/1?app_id&app_key&…`.
 * Limits 25/min, 250/day, 1,000/week, 2,500/month: the client spaces calls 3 s apart and the
 * scan passes a call budget from the persisted quota. Results carry a snippet only, and titles
 * may carry `<strong>` highlights. The key is in the query string, so URLs are never logged.
 * Listings shown to users need "Jobs by Adzuna" attribution (M5).
 */
export const AdzunaResultSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]).transform(String),
  title: z.string().min(1),
  description: optionalText,
  created: optionalText,
  redirect_url: z.url(),
  company: z.object({ display_name: optionalText }).nullish(),
  location: z.object({ display_name: optionalText }).nullish(),
  salary_min: z.number().nullish(),
  salary_max: z.number().nullish(),
  salary_is_predicted: z.union([z.string(), z.number()]).nullish(),
});
export type AdzunaResult = z.infer<typeof AdzunaResultSchema>;

const AdzunaEnvelope = z
  .object({ results: z.array(z.unknown()).nullish() })
  .transform((value) => value.results ?? []);

export function adzunaSearchUrl(
  phrase: string,
  maxDaysOld: number,
  appId: string,
  appKey: string,
): string {
  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    what_phrase: phrase,
    max_days_old: String(maxDaysOld),
    results_per_page: String(SOURCE_QUERIES.adzuna.resultsPerPage),
    sort_by: 'date',
    'content-type': 'application/json',
  });
  return `https://api.adzuna.com/v1/api/jobs/${SOURCE_QUERIES.adzuna.country}/search/1?${params.toString()}`;
}

export function adzunaToRawJob(result: AdzunaResult): RawJob | null {
  const company = result.company?.display_name;
  const title = htmlToText(result.title);
  if (!company || !title) return null;
  const postedAt = parseDate(result.created);
  // Predicted salaries are Adzuna's estimate, not the employer's.
  const predicted = String(result.salary_is_predicted ?? '0') === '1';
  const salary: Salary | undefined =
    !predicted && (typeof result.salary_min === 'number' || typeof result.salary_max === 'number')
      ? {
          currency: 'GBP',
          period: 'year',
          ...(typeof result.salary_min === 'number' ? { min: result.salary_min } : {}),
          ...(typeof result.salary_max === 'number' ? { max: result.salary_max } : {}),
        }
      : undefined;
  return {
    sourceId: 'adzuna',
    externalId: result.id,
    url: result.redirect_url,
    title,
    company,
    locationText: result.location?.display_name ?? '',
    description: { kind: 'snippet', format: 'html', body: result.description ?? '' },
    ...(postedAt ? { postedAt } : {}),
    ...(salary ? { salary } : {}),
  };
}

export function createAdzunaSource(): Source {
  let report: SourceReport = emptyReport();
  return {
    id: 'adzuna',
    health: () => report,
    async fetch(ctx: SourceContext) {
      report = emptyReport();
      const { adzunaAppId: appId, adzunaAppKey: appKey } = ctx.secrets;
      if (!appId || !appKey) {
        report = { ...emptyReport('disabled'), errorCode: 'no_key' };
        return [];
      }
      if (!ctx.criteria) {
        report = { ...emptyReport('skipped'), errorCode: 'no_criteria' };
        return [];
      }
      const { queries, nextCursor } = planQueries(ctx.criteria, ctx.callBudget, ctx.queryCursor);
      if (queries.length === 0) {
        report = {
          ...emptyReport('skipped'),
          errorCode: 'quota_used',
          nextQueryCursor: ctx.queryCursor,
        };
        return [];
      }
      const jobs: RawJob[] = [];
      for (const phrase of queries) {
        // Retries count against the quota too, so stop once the budget is spent.
        if (ctx.http.requests() >= ctx.callBudget) break;
        try {
          const url = adzunaSearchUrl(phrase, ctx.criteria.freshness_days, appId, appKey);
          const results = await ctx.http.getJson(url, AdzunaEnvelope, { label: 'adzuna.search' });
          for (const raw of results) {
            report.fetched += 1;
            const parsed = AdzunaResultSchema.safeParse(raw);
            const job = parsed.success ? adzunaToRawJob(parsed.data) : null;
            if (job) jobs.push(job);
            else report.invalid += 1;
          }
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          report.errors += 1;
          report.errorCode = error.code;
          // Stop at once when Adzuna says we're over its limit, or the run is out of time.
          if (
            error.code === 'deadline' ||
            error.code === 'rate_limited' ||
            error.code === 'host_paused'
          ) {
            break;
          }
        }
      }
      report.status = statusFrom(queries.length, report.errors);
      report.callsUsed = ctx.http.requests();
      report.nextQueryCursor = nextCursor;
      return jobs;
    },
  };
}
