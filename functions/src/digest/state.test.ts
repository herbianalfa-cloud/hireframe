import { STALE_RUN_MS } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import {
  chooseDigest,
  isMorningRun,
  pickMorningRun,
  pickPreviousMorningRun,
  type DigestRun,
} from './state.js';

// 2026-10-07 is a Wednesday in BST (UTC+1): 07:30 London is 06:30Z.
const DAY = '2026-10-07';
const at = (iso: string) => new Date(iso);
const run = (
  id: string,
  startedAt: string,
  status: DigestRun['status'] = 'succeeded',
  trigger: DigestRun['trigger'] = 'schedule',
): DigestRun => ({ id, trigger, status, startedAt: at(startedAt) });

describe('isMorningRun', () => {
  it('is a scheduled run before 12:00 London', () => {
    expect(isMorningRun(run('a', '2026-10-07T06:30:00Z'))).toBe(true);
    expect(isMorningRun(run('a', '2026-10-07T10:59:00Z'))).toBe(true); // 11:59 BST
    expect(isMorningRun(run('a', '2026-10-07T11:00:00Z'))).toBe(false); // 12:00 BST
    expect(isMorningRun(run('a', '2026-10-07T16:30:00Z'))).toBe(false);
  });

  it('ignores manual and rescore runs', () => {
    expect(isMorningRun(run('a', '2026-10-07T06:30:00Z', 'succeeded', 'manual'))).toBe(false);
    expect(isMorningRun(run('a', '2026-10-07T06:30:00Z', 'succeeded', 'rescore'))).toBe(false);
  });

  it('reads the hour in London in winter too (UTC+0)', () => {
    expect(isMorningRun(run('a', '2026-12-02T11:59:00Z'))).toBe(true);
    expect(isMorningRun(run('a', '2026-12-02T12:00:00Z'))).toBe(false);
  });
});

describe('pickMorningRun and pickPreviousMorningRun', () => {
  const runs = [
    run('evening', '2026-10-07T16:30:00Z'),
    run('manual', '2026-10-07T08:00:00Z', 'succeeded', 'manual'),
    run('today', '2026-10-07T06:30:00Z'),
    run('yesterday-pm', '2026-10-06T16:30:00Z'),
    run('yesterday', '2026-10-06T06:30:00Z'),
  ];
  it('finds today’s morning run and the previous day’s', () => {
    expect(pickMorningRun(runs, DAY)?.id).toBe('today');
    expect(pickPreviousMorningRun(runs, DAY)?.id).toBe('yesterday');
  });
  it('finds nothing when there is none', () => {
    expect(pickMorningRun(runs.slice(0, 2), DAY)).toBeUndefined();
    expect(pickPreviousMorningRun(runs.slice(0, 3), DAY)).toBeUndefined();
  });
});

describe('chooseDigest', () => {
  const now = at('2026-10-07T06:50:00Z'); // 07:50 BST
  it('is ready for a succeeded run', () => {
    expect(chooseDigest([run('r', '2026-10-07T06:30:00Z')], DAY, now)).toMatchObject({
      state: 'ready',
      partial: false,
    });
  });

  it('is ready with a notice for a partial run', () => {
    expect(chooseDigest([run('r', '2026-10-07T06:30:00Z', 'partial')], DAY, now)).toMatchObject({
      state: 'ready',
      partial: true,
    });
  });

  it('is failed for a failed run', () => {
    expect(chooseDigest([run('r', '2026-10-07T06:30:00Z', 'failed')], DAY, now).state).toBe(
      'failed',
    );
  });

  it('keeps a failed run failed at any hour, as the store reports a corrupt run document', () => {
    const failed = [run('r', '2026-10-07T06:30:00Z', 'failed')];
    expect(chooseDigest(failed, DAY, at('2026-10-07T06:31:00Z')).state).toBe('failed');
    expect(chooseDigest(failed, DAY, at('2026-10-07T07:20:00Z')).state).toBe('failed');
  });

  it('is in_progress while the run is running, and failed once it is stalled', () => {
    const started = '2026-10-07T06:30:00Z';
    const base = at(started).getTime();
    expect(
      chooseDigest([run('r', started, 'running')], DAY, new Date(base + STALE_RUN_MS - 1)).state,
    ).toBe('in_progress');
    expect(
      chooseDigest([run('r', started, 'running')], DAY, new Date(base + STALE_RUN_MS)).state,
    ).toBe('failed');
  });

  it('is in_progress with no run before 08:15, and missing from 08:15', () => {
    expect(chooseDigest([], DAY, at('2026-10-07T07:14:59Z')).state).toBe('in_progress'); // 08:14:59
    expect(chooseDigest([], DAY, at('2026-10-07T07:15:00Z')).state).toBe('missing'); // 08:15
    expect(chooseDigest([], DAY, at('2026-10-07T07:20:00Z')).state).toBe('missing'); // 08:20
  });

  it('is missing for a day that is not today, however early it is', () => {
    expect(chooseDigest([], '2026-10-06', at('2026-10-07T05:00:00Z')).state).toBe('missing');
  });

  it('does not report yesterday’s or an evening run as today’s', () => {
    const runs = [run('pm', '2026-10-07T16:30:00Z'), run('old', '2026-10-06T06:30:00Z')];
    expect(chooseDigest(runs, DAY, at('2026-10-07T07:30:00Z')).state).toBe('missing');
  });

  it('reports the newest of two morning runs', () => {
    const runs = [
      run('later', '2026-10-07T06:45:00Z', 'running'),
      run('earlier', '2026-10-07T06:30:00Z', 'failed'),
    ];
    expect(chooseDigest(runs, DAY, now)).toMatchObject({ state: 'in_progress' });
  });
});
