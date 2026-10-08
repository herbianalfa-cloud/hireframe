import { htmlToText, tidyText, type HydrateCounts, type Quota } from '@hireframe/shared';

import { FUNNEL, QUOTAS } from '../config.js';
import { basicAuth, HttpError, type HttpClient } from '../http/client.js';
import { log } from '../log.js';
import type { AtsMatch, AtsSearch } from '../lookup/ats-search.js';
import { addCalls, currentQuota, remainingCalls } from '../sources/queries.js';
import { ReedDetailsSchema, reedDetailsUrl } from '../sources/reed.js';
import type { Hydrator, StoredJob } from './run.js';

/**
 * Full text from Reed's details endpoint for jobs about to get a deep read (M4, ADR-029). Reed
 * search results carry a snippet only. Every call counts against Reed's day, week and month
 * quotas (ADR-025), plus its own per-run cap. Adzuna has no full-text API, so its jobs stay
 * snippets (flagged `snippet_only`).
 */
export interface ReedHydratorDeps {
  http: HttpClient;
  apiKey: string;
  /** Details calls allowed this run, before the quotas. */
  perRun: number;
  readQuota: () => Promise<Quota | undefined>;
  saveQuota: (quota: Quota) => Promise<void>;
  /** Saves the full text on the job's description and marks the job `full`. */
  saveFullText: (jobId: string, text: string, now: Date) => Promise<void>;
  now: () => Date;
}

export function createReedHydrator(deps: ReedHydratorDeps): Hydrator {
  const counts: HydrateCounts = { attempted: 0, ok: 0, failed: 0 };
  let quota: Quota | null = null;
  let budget = 0;
  let stopped = false;

  async function ensureBudget(): Promise<void> {
    if (quota) return;
    quota = currentQuota(await deps.readQuota(), deps.now());
    budget = remainingCalls(quota, { ...QUOTAS.reed, perRun: deps.perRun });
  }

  return {
    async fullText(entry: StoredJob) {
      const reed = entry.job.sources.find((source) => source.id === 'reed');
      const url = reed ? reedDetailsUrl(reed.externalId) : null;
      if (!url || stopped) return null;
      await ensureBudget();
      // Retries count against the quota too.
      if (deps.http.requests() >= budget) return null;
      counts.attempted += 1;
      try {
        const details = await deps.http.getJson(url, ReedDetailsSchema, {
          label: 'reed.details',
          headers: { Authorization: basicAuth(deps.apiKey) },
        });
        const text = tidyText(htmlToText(details.jobDescription));
        if (text === '') {
          counts.failed += 1;
          return null;
        }
        await deps.saveFullText(entry.id, text, deps.now());
        counts.ok += 1;
        return text;
      } catch (error) {
        counts.failed += 1;
        const code = error instanceof HttpError ? error.code : 'internal';
        log.warn('hydrate.failed', { source: 'reed', code });
        if (code === 'deadline' || code === 'host_paused' || code === 'rate_limited') {
          stopped = true;
        }
        return null;
      }
    },
    counts: () => ({ ...counts }),
    async finish() {
      const calls = deps.http.requests();
      if (quota && calls > 0) await deps.saveQuota(addCalls(quota, calls));
    },
  };
}

export interface AtsHydratorDeps {
  search: AtsSearch;
  /** Saves the posting's text, source and keys on the job. */
  attach: (entry: StoredJob, match: AtsMatch, now: Date) => Promise<void>;
  now: () => Date;
  /** Called once when the run ends: saves the host pauses the search was given. */
  savePauses?: () => Promise<void>;
}

/**
 * Full text from the board of a watched company for a job with none (an alert job, ADR-049): the
 * same search Lookup uses, on the same official board APIs. Free of quotas (the boards are public
 * and fetched once per run each), but a board that fits no job, or two, gives nothing.
 */
export function createAtsHydrator(deps: AtsHydratorDeps): Hydrator {
  const counts: HydrateCounts = { attempted: 0, ok: 0, failed: 0 };
  return {
    async fullText(entry: StoredJob) {
      const { job } = entry;
      const found = await deps.search.find({
        title: job.title,
        company: job.company,
        city: job.city,
        ...(job.companyId ? { companyId: job.companyId } : {}),
      });
      if (!found.searched) return null;
      counts.attempted += 1;
      const text = found.match?.posting.description.text ?? '';
      if (!found.match || text.length < FUNNEL.minDeepReadChars) {
        if (found.failed) counts.failed += 1;
        return null;
      }
      try {
        await deps.attach(entry, found.match, deps.now());
      } catch (error) {
        counts.failed += 1;
        log.warn('hydrate.failed', {
          source: 'ats',
          code: error instanceof HttpError ? error.code : 'internal',
        });
        return null;
      }
      counts.ok += 1;
      return text;
    },
    counts: () => ({ ...counts }),
    finish: () => deps.savePauses?.() ?? Promise.resolve(),
  };
}

/** Tries each hydrator in turn until one returns text; counts add up. */
export function composeHydrators(hydrators: readonly Hydrator[]): Hydrator {
  return {
    async fullText(entry) {
      for (const hydrator of hydrators) {
        const text = await hydrator.fullText(entry);
        if (text !== null) return text;
      }
      return null;
    },
    counts: () =>
      hydrators.reduce<HydrateCounts>(
        (sum, hydrator) => {
          const counts = hydrator.counts();
          return {
            attempted: sum.attempted + counts.attempted,
            ok: sum.ok + counts.ok,
            failed: sum.failed + counts.failed,
          };
        },
        { attempted: 0, ok: 0, failed: 0 },
      ),
    async finish() {
      for (const hydrator of hydrators) await hydrator.finish();
    },
  };
}
