import type { Quota } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { testHttpClient } from '../sources/testing.js';
import { createAtsSearch } from '../lookup/ats-search.js';
import { FAKE_WATCHLIST } from '../sources/fixtures.js';
import { composeHydrators, createAtsHydrator, createReedHydrator } from './hydrate.js';
import { testJob, TEST_NOW } from './testing.js';

const reedJob = (externalId: string) =>
  testJob({
    descriptionKind: 'snippet',
    sources: [
      {
        id: 'reed',
        url: `https://www.reed.co.uk/jobs/x/${externalId}`,
        externalId,
        seenAt: TEST_NOW,
      },
    ],
  });

function setup(options: { quota?: Quota; perRun?: number } = {}) {
  const saved: { jobId: string; text: string }[] = [];
  const quotas: Quota[] = [];
  const http = testHttpClient();
  const hydrator = createReedHydrator({
    http,
    apiKey: 'fake-reed',
    perRun: options.perRun ?? 20,
    readQuota: () => Promise.resolve(options.quota),
    saveQuota: (quota) => {
      quotas.push(quota);
      return Promise.resolve();
    },
    saveFullText: (jobId, text) => {
      saved.push({ jobId, text });
      return Promise.resolve();
    },
    now: () => TEST_NOW,
  });
  return { hydrator, saved, quotas };
}

describe('createReedHydrator', () => {
  it('fetches and saves Reed full text as plain text, and counts the call', async () => {
    const { hydrator, saved, quotas } = setup();
    const text = await hydrator.fullText({ id: 'a', job: reedJob('50005678') });
    expect(text).toContain('Build dashboards in SQL and Metabase');
    expect(text).not.toContain('<li>');
    expect(saved).toEqual([{ jobId: 'a', text }]);
    await hydrator.finish();
    expect(quotas[0]).toMatchObject({ dayCount: 1, weekCount: 1, monthCount: 1 });
    expect(hydrator.counts()).toEqual({ attempted: 1, ok: 1, failed: 0 });
  });

  it('skips jobs without a Reed source, at no cost', async () => {
    const { hydrator, quotas } = setup();
    expect(await hydrator.fullText({ id: 'a', job: testJob() })).toBeNull();
    await hydrator.finish();
    expect(quotas).toEqual([]);
    expect(hydrator.counts().attempted).toBe(0);
  });

  it('stops at the per-run cap and at the daily quota', async () => {
    const capped = setup({ perRun: 1 });
    await capped.hydrator.fullText({ id: 'a', job: reedJob('1') });
    expect(await capped.hydrator.fullText({ id: 'b', job: reedJob('2') })).toBeNull();

    const quota: Quota = {
      day: '2026-10-05',
      dayCount: 300,
      week: '2026-W41',
      weekCount: 300,
      month: '2026-10',
      monthCount: 300,
    };
    const spent = setup({ quota });
    expect(await spent.hydrator.fullText({ id: 'a', job: reedJob('1') })).toBeNull();
    expect(spent.hydrator.counts().attempted).toBe(0);
  });
});

describe('ATS hydrator', () => {
  const alertJob = (patch: Parameters<typeof testJob>[0] = {}) =>
    testJob({
      title: 'Product Analyst',
      company: 'Acme Analytics',
      city: 'london',
      descriptionKind: 'none',
      sources: [
        {
          id: 'linkedin-alert',
          url: 'https://www.linkedin.com/jobs/view/4012345678',
          externalId: '4012345678',
          seenAt: TEST_NOW,
        },
      ],
      ...patch,
    });

  function atsSetup() {
    const attached: { jobId: string; sourceId: string }[] = [];
    const hydrator = createAtsHydrator({
      search: createAtsSearch({
        http: testHttpClient(),
        watched: () => Promise.resolve(FAKE_WATCHLIST),
        maxBoards: 5,
      }),
      attach: (entry, match) => {
        attached.push({ jobId: entry.id, sourceId: match.posting.sourceId });
        return Promise.resolve();
      },
      now: () => TEST_NOW,
    });
    return { hydrator, attached };
  }

  it('returns the board posting’s text for an alert job and attaches it', async () => {
    const { hydrator, attached } = atsSetup();
    const text = await hydrator.fullText({ id: 'j1', job: alertJob() });
    expect(text).toContain('weekly metrics review');
    expect(attached).toEqual([{ jobId: 'j1', sourceId: 'greenhouse' }]);
    expect(hydrator.counts()).toEqual({ attempted: 1, ok: 1, failed: 0 });
  });

  it('is silent for a company that is not on the watchlist (not an attempt)', async () => {
    const { hydrator, attached } = atsSetup();
    expect(
      await hydrator.fullText({ id: 'j1', job: alertJob({ company: 'Nobody Ltd' }) }),
    ).toBeNull();
    expect(attached).toEqual([]);
    expect(hydrator.counts()).toEqual({ attempted: 0, ok: 0, failed: 0 });
  });

  it('counts an attempt with no match, but not as a failure', async () => {
    const { hydrator } = atsSetup();
    expect(
      await hydrator.fullText({ id: 'j1', job: alertJob({ title: 'Chief Wizard' }) }),
    ).toBeNull();
    expect(hydrator.counts()).toEqual({ attempted: 1, ok: 0, failed: 0 });
  });

  it('composes with Reed: the first hydrator with text wins, counts add up', async () => {
    const first = {
      fullText: () => Promise.resolve(null),
      counts: () => ({ attempted: 2, ok: 0, failed: 1 }),
      finish: () => Promise.resolve(),
    };
    const { hydrator } = atsSetup();
    const both = composeHydrators([first, hydrator]);
    expect(await both.fullText({ id: 'j1', job: alertJob() })).toContain('weekly metrics review');
    expect(both.counts()).toEqual({ attempted: 3, ok: 1, failed: 1 });
    await expect(both.finish()).resolves.toBeUndefined();
  });
});
