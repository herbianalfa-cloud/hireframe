import { describe, expect, it, vi } from 'vitest';

import { setLogSink } from '../log.js';
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
  const pipeline = vi.fn<DigestStore['pipeline']>(() =>
    Promise.resolve({
      needsInput: 2,
      generating: 1,
      ready: 3,
      appliedThisWeek: 4,
      weeklyTarget: 10,
    }),
  );
  const store: DigestStore = {
    recentRuns: () => Promise.resolve(runs),
    jobsSince,
    usage: () => Promise.resolve({ spendPence: 100, capPence: 1500 }),
    sources,
    waitingForDescription,
    pipeline,
  };
  return { store, jobsSince, sources, waitingForDescription, pipeline };
}

const request = { kind: 'morning', day: DAY } as const;

describe('buildDigest', () => {
  const runs = [
    run('today', '2026-10-07T06:30:00Z', { status: 'partial' }),
    run('yesterday-pm', '2026-10-06T16:30:00Z'),
    run('yesterday', '2026-10-06T06:30:00Z'),
  ];

  it('is ready, lists open jobs judged since the previous morning run finished', async () => {
    const { store, jobsSince } = fakeStore(runs);
    const out = await buildDigest(store, request, NOW);
    expect(out.state).toBe('ready');
    expect(jobsSince).toHaveBeenCalledTimes(3);
    for (const [, since] of jobsSince.mock.calls) {
      // The previous morning run's finishedAt (the fixture's equals its start).
      expect(since).toEqual(new Date('2026-10-06T06:30:00Z'));
    }
    expect(out.text).toContain('Analyst · Acme');
    expect(out.text).toContain('Some sources failed in this run.');
    expect(out.text).toContain('Source reed: failing (http_429)');
    expect(out.text).toContain('2 waiting for a description');
  });

  it('measures from the previous morning run’s finishedAt, and from startedAt without one', async () => {
    const finished = [
      run('today', '2026-10-07T06:30:00Z'),
      run('yesterday', '2026-10-06T06:30:00Z', { finishedAt: new Date('2026-10-06T06:41:00Z') }),
    ];
    const first = fakeStore(finished);
    await buildDigest(first.store, request, NOW);
    expect(first.jobsSince.mock.calls[0]?.[1]).toEqual(new Date('2026-10-06T06:41:00Z'));

    const unfinished = run('yesterday', '2026-10-06T06:30:00Z');
    delete unfinished.finishedAt;
    const second = fakeStore([run('today', '2026-10-07T06:30:00Z'), unfinished]);
    await buildDigest(second.store, request, NOW);
    expect(second.jobsSince.mock.calls[0]?.[1]).toEqual(new Date('2026-10-06T06:30:00Z'));
  });

  it('says the spend is unknown, not 0p, when the usage record is invalid', async () => {
    const { store } = fakeStore(runs);
    const out = await buildDigest({ ...store, usage: () => Promise.resolve(null) }, request, NOW);
    expect(out.text).toContain('Spend unknown');
    expect(out.text).not.toContain('0p of');
  });

  it('looks back 24 h from the run when there is no earlier morning run', async () => {
    const { store, jobsSince } = fakeStore([run('today', '2026-10-07T06:30:00Z')]);
    await buildDigest(store, request, NOW);
    expect(jobsSince.mock.calls[0]?.[1]).toEqual(new Date('2026-10-06T06:30:00Z'));
  });

  it('adds the Pipeline line from one pipeline read', async () => {
    const { store, pipeline } = fakeStore(runs);
    const out = await buildDigest(store, request, NOW);
    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(out.text).toContain(
      '2 need your input · 1 generating · 3 ready to send · 4 applied this week of 10',
    );
  });

  it('still sends, without the Pipeline line, when the applications read fails', async () => {
    const { store } = fakeStore(runs);
    const failing: DigestStore = {
      ...store,
      pipeline: () => Promise.reject(Object.assign(new Error('boom: Acme secret'), { code: 14 })),
    };
    const out = await buildDigest(failing, request, NOW);
    expect(out.state).toBe('ready');
    expect(out.text).toContain('Analyst · Acme');
    expect(out.text).not.toContain('PIPELINE');
    expect(out.html).not.toContain('Pipeline</h2>');
  });

  it('logs a failed applications read by error class and code only', async () => {
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    setLogSink((_level, event, fields) => lines.push({ event, fields }));
    try {
      const { store } = fakeStore(runs);
      await buildDigest(
        {
          ...store,
          pipeline: () =>
            Promise.reject(Object.assign(new Error('Acme Analytics secret'), { code: 14 })),
        },
        request,
        NOW,
      );
    } finally {
      setLogSink();
    }
    expect(lines).toEqual([
      { event: 'digest.pipeline_failed', fields: { errorName: 'Error', errorCode: 14 } },
    ]);
    expect(JSON.stringify(lines)).not.toContain('Acme');
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
    const read = readRunDoc('today', {
      trigger: 'schedule',
      startedAt: new Date('2026-10-07T06:30:00Z'),
    });
    expect(read?.valid).toBe(false);
    const { store, jobsSince } = fakeStore(read ? [read.run] : []);
    const out = await buildDigest(store, request, new Date('2026-10-07T07:20:00Z'));
    expect(out.state).toBe('failed');
    expect(out.text).toContain('run_invalid');
    expect(jobsSince).not.toHaveBeenCalled();
  });

  it('reads no secret-bearing config and makes no model call (the store has no such method)', () => {
    const { store } = fakeStore([]);
    expect(Object.keys(store).sort()).toEqual([
      'jobsSince',
      'pipeline',
      'recentRuns',
      'sources',
      'usage',
      'waitingForDescription',
    ]);
  });
});
