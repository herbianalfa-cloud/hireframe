import { describe, expect, it, vi } from 'vitest';

import { buildDigest } from './build.js';
import type { DigestJobList } from './render.js';
import { readRunDoc, type DigestStore, type StoredDigestRun } from './store.js';

const DAY = '2026-10-07';
const NOW = new Date('2026-10-07T06:50:00Z'); // 07:50 BST

function run(
  id: string,
  startedAt: string,
  overrides: Partial<StoredDigestRun> = {},
): StoredDigestRun {
  return {
    id,
    trigger: 'schedule',
    status: 'succeeded',
    startedAt: new Date(startedAt),
    finishedAt: new Date(startedAt),
    perSource: {},
    perStage: {
      s2: {
        in: 5,
        passed: 2,
        skipped: 3,
        expired: 0,
        review: 0,
        queued: 0,
        costPence: 1,
        durationMs: 1,
      },
    },
    costPence: 1,
    errors: [],
    schemaVersion: 1,
    ...overrides,
  };
}

const list = (titles: string[]): DigestJobList => ({
  jobs: titles.map((title, i) => ({ id: `${title}-${String(i)}`, title, company: 'Acme' })),
  total: titles.length,
});

function fakeStore(runs: StoredDigestRun[]) {
  const jobsSince = vi.fn<DigestStore['jobsSince']>((verdict) =>
    Promise.resolve(list(verdict === 'apply' ? ['Analyst'] : [])),
  );
  const sources = vi.fn<DigestStore['sources']>(() =>
    Promise.resolve([{ id: 'reed', status: 'failing', errorCode: 'http_429' }]),
  );
  const waitingForDescription = vi.fn<DigestStore['waitingForDescription']>(() =>
    Promise.resolve(2),
  );
  const store: DigestStore = {
    recentRuns: () => Promise.resolve(runs),
    jobsSince,
    usage: () => Promise.resolve({ spendPence: 100, capPence: 1500 }),
    sources,
    waitingForDescription,
  };
  return { store, jobsSince, sources, waitingForDescription };
}

const request = { kind: 'morning', day: DAY } as const;

describe('buildDigest', () => {
  const runs = [
    run('today', '2026-10-07T06:30:00Z', { status: 'partial' }),
    run('yesterday-pm', '2026-10-06T16:30:00Z'),
    run('yesterday', '2026-10-06T06:30:00Z'),
  ];

  it('is ready, lists open jobs judged since the previous morning run started', async () => {
    const { store, jobsSince } = fakeStore(runs);
    const out = await buildDigest(store, request, NOW);
    expect(out.state).toBe('ready');
    expect(jobsSince).toHaveBeenCalledTimes(3);
    for (const [, since] of jobsSince.mock.calls) {
      expect(since).toEqual(new Date('2026-10-06T06:30:00Z'));
    }
    expect(out.text).toContain('Analyst · Acme');
    expect(out.text).toContain('Some sources failed in this run.');
    expect(out.text).toContain('Source reed: failing (http_429)');
    expect(out.text).toContain('2 waiting for a description');
  });

  it('looks back 24 h from the run when there is no earlier morning run', async () => {
    const { store, jobsSince } = fakeStore([run('today', '2026-10-07T06:30:00Z')]);
    await buildDigest(store, request, NOW);
    expect(jobsSince.mock.calls[0]?.[1]).toEqual(new Date('2026-10-06T06:30:00Z'));
  });

  it('is in_progress with no job, source or description reads while the run is running', async () => {
    const { store, jobsSince, sources, waitingForDescription } = fakeStore([
      run('today', '2026-10-07T06:45:00Z', { status: 'running' }),
    ]);
    const out = await buildDigest(store, request, NOW);
    expect(out.state).toBe('in_progress');
    expect(jobsSince).not.toHaveBeenCalled();
    expect(sources).not.toHaveBeenCalled();
    expect(waitingForDescription).not.toHaveBeenCalled();
    expect(out.text).toContain('has not finished yet');
  });

  it('is failed for a failed run, with run health but no job lists', async () => {
    const { store, jobsSince } = fakeStore([
      run('today', '2026-10-07T06:30:00Z', { status: 'failed', errors: [{ code: 'timeout' }] }),
    ]);
    const out = await buildDigest(store, request, NOW);
    expect(out.state).toBe('failed');
    expect(jobsSince).not.toHaveBeenCalled();
    expect(out.text).toContain('- timeout');
  });

  it('is missing after 08:15 with no morning run', async () => {
    const { store } = fakeStore([run('yesterday', '2026-10-06T06:30:00Z')]);
    const out = await buildDigest(store, request, new Date('2026-10-07T07:20:00Z'));
    expect(out.state).toBe('missing');
  });

  it('reports a corrupt morning run as failed with its code, not missing', async () => {
    const { store, jobsSince } = fakeStore([
      readRunDoc('today', { trigger: 'schedule', startedAt: new Date('2026-10-07T06:30:00Z') })!
        .run,
    ]);
    const out = await buildDigest(store, request, new Date('2026-10-07T07:20:00Z'));
    expect(out.state).toBe('failed');
    expect(out.text).toContain('run_invalid');
    expect(jobsSince).not.toHaveBeenCalled();
  });

  it('reads no secret-bearing config and makes no model call (the store has no such method)', () => {
    const { store } = fakeStore([]);
    expect(Object.keys(store).sort()).toEqual([
      'jobsSince',
      'recentRuns',
      'sources',
      'usage',
      'waitingForDescription',
    ]);
  });
});
