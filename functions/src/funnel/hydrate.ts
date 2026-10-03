import { htmlToText, tidyText, type HydrateCounts, type Quota } from '@hireframe/shared';

import { QUOTAS } from '../config.js';
import { basicAuth, HttpError, type HttpClient } from '../http/client.js';
import { log } from '../log.js';
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
