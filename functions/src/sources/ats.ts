import type { RawJob } from '@hireframe/shared';
import { z } from 'zod';

import { hostPolicy, SCAN } from '../config.js';
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

/**
 * The boards to fetch this run (pure). Each host gets as many boards as fit in its share of
 * the fetch budget at its request interval; when a host has more, the least recently scanned
 * go first (never scanned before anything else, then by ID), and the rest wait for a later run.
 */
export function boardsThisRun(
  companies: readonly WatchedCompany[],
  boardUrl: (company: WatchedCompany) => string,
  budgetMs: number = SCAN.fetchBudgetMs * SCAN.boardTimeShare,
): { selected: WatchedCompany[]; deferred: number } {
  const byHost = new Map<string, WatchedCompany[]>();
  for (const company of companies) {
    const host = new URL(boardUrl(company)).host;
    byHost.set(host, [...(byHost.get(host) ?? []), company]);
  }
  const selected: WatchedCompany[] = [];
  let deferred = 0;
  for (const [host, list] of byHost) {
    const cap = Math.max(1, Math.floor(budgetMs / hostPolicy(host).intervalMs));
    const oldestFirst = [...list].sort(
      (a, b) =>
        (a.lastScannedAt?.getTime() ?? -Infinity) - (b.lastScannedAt?.getTime() ?? -Infinity) ||
        a.id.localeCompare(b.id),
    );
    selected.push(...oldestFirst.slice(0, cap));
    deferred += Math.max(0, oldestFirst.length - cap);
  }
  return { selected, deferred };
}

export function createAtsSource<Item>(spec: AtsSpec<Item>): Source {
  let report: SourceReport = emptyReport();
  return {
    id: spec.id,
    health: () => report,
    async fetch(ctx: SourceContext) {
      const watched = ctx.companies.filter(
        (company) => company.ats.type === spec.id && company.ats.token,
      );
      const { selected: companies, deferred } = boardsThisRun(watched, spec.boardUrl);
      report = emptyReport(companies.length === 0 ? 'skipped' : 'ok');
      if (deferred > 0) report.deferred = deferred;
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
      // Boards skipped because their host is paused weren't tried: they count as neither
      // attempts nor failures. A source whose every board was skipped is `skipped`.
      const paused = boards.filter((board) => board.errorCode === 'host_paused').length;
      if (companies.length > 0) {
        report.status = statusFrom(companies.length - paused, report.errors - paused);
      }
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
