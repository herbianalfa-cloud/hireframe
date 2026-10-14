import { WIPE_STEPS } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { WIPE_COLLECTIONS, planSourceDoc } from './plan.js';

describe('the wipe plan (ADR-057)', () => {
  it('covers every document step, events and alertMessages included', () => {
    const docSteps = WIPE_STEPS.filter((step) => step !== 'cvFiles');
    expect(Object.keys(WIPE_COLLECTIONS).sort()).toEqual([...docSteps].sort());
    expect(Object.values(WIPE_COLLECTIONS)).toEqual(
      expect.arrayContaining(['events', 'alertMessages', 'jobs', 'applications', 'companies']),
    );
  });

  it('never names config, criteria, usage, locks, nonces or the profile', () => {
    const named = Object.values(WIPE_COLLECTIONS);
    for (const kept of ['config', 'criteria', 'usage', 'locks', 'nonces', 'profile']) {
      expect(named).not.toContain(kept);
    }
  });

  it('runs applications first and sources last', () => {
    expect(WIPE_STEPS[0]).toBe('applications');
    expect(WIPE_STEPS.at(-1)).toBe('sources');
    expect(WIPE_STEPS.indexOf('jobs')).toBeLessThan(WIPE_STEPS.indexOf('events'));
  });
});

describe('planSourceDoc', () => {
  const quota = { day: '2026-10-14', dayCount: 3 };
  const pausedHosts = [{ host: 'boards.greenhouse.io', until: new Date('2026-10-15T00:00:00Z') }];

  it('keeps a doc that holds only quota and pauses', () => {
    expect(planSourceDoc({ quota, pausedHosts, updatedAt: new Date(), schemaVersion: 1 })).toEqual({
      action: 'keep',
    });
    expect(planSourceDoc({ quota })).toEqual({ action: 'keep' });
  });

  it('rewrites a health doc to just quota and pauses', () => {
    expect(planSourceDoc({ status: 'ok', quota, pausedHosts, lastCounts: {} })).toEqual({
      action: 'rewrite',
      kept: { quota, pausedHosts },
    });
    expect(planSourceDoc({ status: 'ok', quota })).toEqual({
      action: 'rewrite',
      kept: { quota },
    });
  });

  it('deletes a doc with neither', () => {
    expect(planSourceDoc({ status: 'ok', lastCounts: {}, bySender: {} })).toEqual({
      action: 'delete',
    });
    expect(planSourceDoc({ updatedAt: new Date(), schemaVersion: 1 })).toEqual({
      action: 'delete',
    });
    expect(planSourceDoc(undefined)).toEqual({ action: 'delete' });
  });
});
