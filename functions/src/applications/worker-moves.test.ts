import type { Application } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import {
  planAttempt,
  planBlocked,
  planReady,
  planRegenerate,
  planRetry,
  planStart,
  planWithdraw,
} from './transitions.js';
import { requirementOf, testJob } from './testing.js';

const T0 = new Date('2026-10-12T08:00:00Z');
const T1 = new Date('2026-10-12T08:10:00Z');

const generating = (over: Partial<Application> = {}): Application => ({
  jobId: 'job-1',
  job: { title: 'Data Analyst', company: 'Northwind Analytics', verdict: 'apply' },
  stage: 'generating',
  stageAt: T0,
  startedAt: T0,
  updatedAt: T0,
  questions: [],
  attempt: 0,
  cvIds: [],
  schemaVersion: 1,
  ...over,
});

describe('the worker moves', () => {
  it('planAttempt adds one and keeps the stage and its clock', () => {
    const next = planAttempt(generating(), T1);
    expect(next).toMatchObject({ stage: 'generating', attempt: 1, stageAt: T0, updatedAt: T1 });
  });

  it('planAttempt refuses past the maximum and off generating', () => {
    expect(planAttempt(generating({ attempt: 2 }), T1)).toBeNull();
    expect(planAttempt(generating({ stage: 'ready' }), T1)).toBeNull();
  });

  it('planRetry keeps the attempt and records the codes; it refuses with none left', () => {
    const next = planRetry(generating({ attempt: 1 }), ['too_long'], T1);
    expect(next).toMatchObject({ stage: 'generating', attempt: 1, lastIssues: ['too_long'] });
    expect(planRetry(generating({ attempt: 2 }), ['too_long'], T1)).toBeNull();
    const cleared = planRetry(generating({ attempt: 1, lastIssues: ['uncited'] }), [], T1);
    expect(cleared?.lastIssues).toBeUndefined();
  });

  it('planBlocked goes to chosen with the reason and keeps attempt, notes and versions', () => {
    const next = planBlocked(
      generating({ attempt: 2, notes: 'n', cvIds: ['job-1-v1'], currentCvId: 'job-1-v1' }),
      'invalid_output',
      T1,
      ['unsupported_text'],
    );
    expect(next).toMatchObject({
      stage: 'chosen',
      stageAt: T1,
      attempt: 2,
      notes: 'n',
      cvIds: ['job-1-v1'],
      currentCvId: 'job-1-v1',
      blocked: { code: 'invalid_output', at: T1 },
      lastIssues: ['unsupported_text'],
    });
    expect(planBlocked(generating({ stage: 'ready' }), 'error', T1)).toBeNull();
  });

  it('planReady appends the version and clears the codes and any block', () => {
    const next = planReady(
      generating({ attempt: 2, lastIssues: ['uncited'], cvIds: ['job-1-v1'] }),
      'job-1-v2',
      T1,
    );
    expect(next).toMatchObject({
      stage: 'ready',
      attempt: 2,
      cvIds: ['job-1-v1', 'job-1-v2'],
      currentCvId: 'job-1-v2',
    });
    expect(next?.lastIssues).toBeUndefined();
    expect(planReady(generating({ stage: 'chosen' }), 'job-1-v1', T1)).toBeNull();
  });

  it('resets attempt only on the owner moves: start, regenerate, withdraw', () => {
    const known = {
      job: { ...testJob([requirementOf('x')]), verdict: 'apply' as const },
      headerExists: true,
      now: T1,
    };
    const spent = generating({ attempt: 2 });
    expect(planAttempt(spent, T1)).toBeNull();
    // The worker's own moves keep the counter...
    expect(planBlocked(spent, 'attempts_exhausted', T1)?.attempt).toBe(2);
    // ...and the owner's moves from the places it ends up put it back.
    const blocked = planBlocked(spent, 'attempts_exhausted', T1);
    expect(blocked && planStart('job-1', blocked, known, 'retry')?.attempt).toBe(0);
    const ready = generating({ stage: 'ready', attempt: 2 });
    expect(planRegenerate(ready, undefined, T1)?.attempt).toBe(0);
    expect(planWithdraw(generating({ attempt: 2 }), T1)?.attempt).toBe(0);
  });
});
