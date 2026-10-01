import type { RawJob } from '@hireframe/shared';
import { z } from 'zod';

import { SCAN } from '../config.js';
import { HttpError } from '../http/client.js';
import {
  eachLimited,
  emptyReport,
  statusFrom,
  type BoardResult,
  type Source,
  type SourceContext,
  type SourceReport,
  type WatchedCompany,
} from './types.js';

/**
 * Shared runner for the ATS board sources (Greenhouse, Lever, Ashby, Workable). Each watched
 * company of that ATS is one board request. The envelope is checked as a whole; each posting is
 * validated on its own, so one odd posting never loses the board (ADR-029).
 */
export interface AtsSpec<Item> {
  id: 'greenhouse' | 'lever' | 'ashby' | 'workable';
  boardUrl: (company: WatchedCompany) => string;
  /** Pulls the postings array out of the response. */
  envelope: z.ZodType<unknown[]>;
  item: z.ZodType<Item>;
  /** Null for postings that aren't public jobs (e.g. Ashby's unlisted ones). */
  toRawJob: (item: Item, company: WatchedCompany) => RawJob | null;
}

export function createAtsSource<Item>(spec: AtsSpec<Item>): Source {
  let report: SourceReport = emptyReport();
  return {
    id: spec.id,
    health: () => report,
    async fetch(ctx: SourceContext) {
      const companies = ctx.companies.filter(
        (company) => company.ats.type === spec.id && company.ats.token,
      );
      report = emptyReport(companies.length === 0 ? 'skipped' : 'ok');
      const jobs: RawJob[] = [];
      const boards: BoardResult[] = [];
      await eachLimited(companies, SCAN.boardConcurrency, async (company) => {
        try {
          const items = await ctx.http.getJson(spec.boardUrl(company), spec.envelope, {
            label: `${spec.id}.board`,
          });
          let count = 0;
          for (const raw of items) {
            report.fetched += 1;
            const parsed = spec.item.safeParse(raw);
            if (!parsed.success) {
              report.invalid += 1;
              continue;
            }
            const job = spec.toRawJob(parsed.data, company);
            if (job) {
              jobs.push(job);
              count += 1;
            }
          }
          boards.push({ companyId: company.id, status: 'ok', jobs: count });
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          report.errors += 1;
          report.errorCode = error.code;
          boards.push({
            companyId: company.id,
            status: error.code === 'not_found' ? 'not_found' : 'error',
            jobs: 0,
            errorCode: error.code,
          });
        }
      });
      report.boards = boards;
      if (companies.length > 0) report.status = statusFrom(companies.length, report.errors);
      return jobs;
    },
  };
}

/** Envelope helpers: the postings array at the top level or under a key. */
export const arrayEnvelope = z.array(z.unknown());
export function keyedEnvelope(key: string): z.ZodType<unknown[]> {
  return z.object({ [key]: z.array(z.unknown()) }).transform((value) => value[key] ?? []);
}

/** Optional string fields arrive as null, missing or a string; this reads all three. */
export const optionalText = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);
