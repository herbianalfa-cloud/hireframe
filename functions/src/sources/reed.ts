import type { RawJob, Salary } from '@hireframe/shared';
import { z } from 'zod';

import { SOURCE_QUERIES } from '../config.js';
import { basicAuth, HttpError } from '../http/client.js';
import { optionalText } from './ats.js';
import { planQueries } from './queries.js';
import {
  emptyReport,
  statusFrom,
  type Source,
  type SourceContext,
  type SourceReport,
} from './types.js';

/**
 * Reed Jobseeker API (keyed, Basic auth with the key as the user name; ADR-025):
 * `www.reed.co.uk/api/1.0/search?keywords=…`. Search results carry a snippet only; full text
 * comes from `/api/1.0/jobs/{id}` for S2 survivors in M4. Queries come from the lane titles.
 */
export const ReedResultSchema = z.object({
  jobId: z.number().int().positive(),
  employerName: optionalText,
  jobTitle: z.string().min(1),
  locationName: optionalText,
  minimumSalary: z.number().nullish(),
  maximumSalary: z.number().nullish(),
  currency: optionalText,
  date: optionalText,
  jobDescription: optionalText,
  jobUrl: z.url(),
});
export type ReedResult = z.infer<typeof ReedResultSchema>;

const ReedEnvelope = z
  .object({ results: z.array(z.unknown()).nullish() })
  .transform((value) => value.results ?? []);

export function reedSearchUrl(keywords: string): string {
  const params = new URLSearchParams({
    keywords,
    resultsToTake: String(SOURCE_QUERIES.reed.resultsToTake),
  });
  return `https://www.reed.co.uk/api/1.0/search?${params.toString()}`;
}

/** Reed dates are `dd/mm/yyyy`. */
export function parseReedDate(value: string | undefined): Date | undefined {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value ?? '');
  if (!match) return undefined;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function reedToRawJob(result: ReedResult): RawJob | null {
  if (!result.employerName) return null;
  const postedAt = parseReedDate(result.date);
  const currency = result.currency ?? 'GBP';
  const salary: Salary | undefined =
    typeof result.minimumSalary === 'number' || typeof result.maximumSalary === 'number'
      ? {
          currency: /^[A-Z]{3}$/.test(currency) ? currency : 'GBP',
          period: 'unknown',
          ...(typeof result.minimumSalary === 'number' ? { min: result.minimumSalary } : {}),
          ...(typeof result.maximumSalary === 'number' ? { max: result.maximumSalary } : {}),
        }
      : undefined;
  return {
    sourceId: 'reed',
    externalId: String(result.jobId),
    url: result.jobUrl,
    title: result.jobTitle,
    company: result.employerName,
    locationText: result.locationName ?? '',
    description: { kind: 'snippet', format: 'html', body: result.jobDescription ?? '' },
    ...(postedAt ? { postedAt } : {}),
    ...(salary ? { salary } : {}),
  };
}

export function createReedSource(): Source {
  let report: SourceReport = emptyReport();
  return {
    id: 'reed',
    health: () => report,
    async fetch(ctx: SourceContext) {
      report = emptyReport();
      if (!ctx.secrets.reedApiKey) {
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
      const auth = basicAuth(ctx.secrets.reedApiKey);
      const jobs: RawJob[] = [];
      // One query at a time: the host is spaced anyway, and the quota counts every call.
      for (const keywords of queries) {
        // Retries count against the quota too, so stop once the budget is spent.
        if (ctx.http.requests() >= ctx.callBudget) break;
        try {
          const results = await ctx.http.getJson(reedSearchUrl(keywords), ReedEnvelope, {
            label: 'reed.search',
            headers: { Authorization: auth },
          });
          for (const raw of results) {
            report.fetched += 1;
            const parsed = ReedResultSchema.safeParse(raw);
            const job = parsed.success ? reedToRawJob(parsed.data) : null;
            if (job) jobs.push(job);
            else report.invalid += 1;
          }
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          report.errors += 1;
          report.errorCode = error.code;
          if (error.code === 'deadline' || error.code === 'host_paused') break;
        }
      }
      report.status = statusFrom(queries.length, report.errors);
      report.callsUsed = ctx.http.requests();
      report.nextQueryCursor = nextCursor;
      return jobs;
    },
  };
}
