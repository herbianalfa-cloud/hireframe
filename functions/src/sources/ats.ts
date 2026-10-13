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

/** The board a company's scan result is about: `type:token:host` (ADR-056). */
export function boardKey(company: WatchedCompany): string {
  return `${company.ats.type}:${company.ats.token ?? ''}:${company.ats.host ?? 'default'}`;
}

/**
 * A board already known to be gone is skipped without a request until its last probe is
 * `brokenBoardReprobeMs` old. A changed token or host no longer matches the recorded key, so
 * it is probed at once.
 */
export function isSkippedGone(
  company: WatchedCompany,
  now: Date,
  reprobeMs: number = SCAN.brokenBoardReprobeMs,
): boolean {
  const scan = company.lastScan;
  if (!scan?.broken || scan.board !== boardKey(company)) return false;
  if (!company.lastScannedAt) return false;
  return now.getTime() - company.lastScannedAt.getTime() < reprobeMs;
}

/** The most frequent error code; ties go to the alphabetically first (deterministic). */
export function dominantCode(codes: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
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

/**
 * A board's postings read without a scan: the URL, the envelope and a per-item reader that
 * validates each posting on its own, as the source does. Lookup uses it to search one board
 * (ADR-049).
 */
export interface AtsBoardReader {
  boardUrl: (company: WatchedCompany) => string;
  envelope: z.ZodType<unknown[]>;
  /** Valid postings as raw jobs; `invalid` counts the ones that failed the item schema. */
  read: (items: readonly unknown[], company: WatchedCompany) => { jobs: RawJob[]; invalid: number };
}

export function boardReader<Item>(spec: AtsSpec<Item>): AtsBoardReader {
  return {
    boardUrl: spec.boardUrl,
    envelope: spec.envelope,
    read(items, company) {
      const jobs: RawJob[] = [];
      let invalid = 0;
      for (const raw of items) {
        const parsed = spec.item.safeParse(raw);
        if (!parsed.success) {
          invalid += 1;
          continue;
        }
        const job = spec.toRawJob(parsed.data, company);
        if (job) jobs.push(job);
      }
      return { jobs, invalid };
    },
  };
}

export function createAtsSource<Item>(spec: AtsSpec<Item>): Source {
  let report: SourceReport = emptyReport();
  return {
    id: spec.id,
    health: () => report,
    async fetch(ctx: SourceContext) {
      const ofType = ctx.companies.filter(
        (company) => company.ats.type === spec.id && company.ats.token,
      );
      // Boards known to be gone are neither requested nor written: their `lastScannedAt` must
      // stay put, or the weekly re-probe would never come due (ADR-056).
      const skipped = ofType.filter((company) => isSkippedGone(company, ctx.now));
      const watched = ofType.filter((company) => !skipped.includes(company));
      const { selected: companies, deferred } = boardsThisRun(watched, spec.boardUrl);
      report = emptyReport(companies.length === 0 && skipped.length === 0 ? 'skipped' : 'ok');
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
      const paused = boards.filter((board) => board.errorCode === 'host_paused');
      const tried = boards.filter((board) => board.errorCode !== 'host_paused');
      // A 404 is a watchlist fact, not a source failure, unless it looks like an outage:
      // every board attempted on a host (at least `goneGuardMinBoards`) was not_found.
      const byHost = new Map<string, BoardResult[]>();
      for (const board of tried) {
        const company = companies.find((entry) => entry.id === board.companyId);
        if (!company) continue;
        const host = new URL(spec.boardUrl(company)).host;
        byHost.set(host, [...(byHost.get(host) ?? []), board]);
      }
      const outage = new Set<BoardResult>();
      for (const list of byHost.values()) {
        if (
          list.length >= SCAN.goneGuardMinBoards &&
          list.every((board) => board.status === 'not_found')
        ) {
          for (const board of list) outage.add(board);
        }
      }
      const gone = tried.filter((board) => board.status === 'not_found' && !outage.has(board));
      const failed = tried.filter((board) => board.status !== 'ok' && !gone.includes(board));
      report.errors = failed.length + paused.length;
      const realCodes = failed.flatMap((board) => (board.errorCode ? [board.errorCode] : []));
      const code = dominantCode(realCodes) ?? (paused.length > 0 ? 'host_paused' : undefined);
      if (code) report.errorCode = code;
      if (gone.length + skipped.length > 0) report.gone = gone.length + skipped.length;
      if (skipped.length > 0) report.skippedGone = skipped.length;

      const attempts = tried.length - gone.length;
      if (companies.length > 0 || skipped.length > 0) {
        // Nothing but boards that no longer exist is a healthy source, not a skipped one.
        const onlyGone = attempts === 0 && gone.length + skipped.length > 0 && paused.length === 0;
        report.status = onlyGone ? 'ok' : statusFrom(attempts, failed.length);
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
