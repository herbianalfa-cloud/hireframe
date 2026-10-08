import type { Run } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { funnelText } from './labels';

const AT = new Date('2026-10-01T08:00:00Z');

const s2 = {
  in: 8,
  passed: 3,
  skipped: 4,
  expired: 1,
  review: 0,
  queued: 0,
  costPence: 1,
  durationMs: 9,
};
const s3 = {
  in: 3,
  apply: 1,
  near_miss: 1,
  wildcard: 0,
  skip: 1,
  expired: 2,
  review: 0,
  queued: 0,
  drift: 0,
  recomputed: 0,
  costPence: 3,
  durationMs: 30,
};

function runWith(perStage: Run['perStage']): Run {
  return {
    trigger: 'schedule',
    status: 'succeeded',
    startedAt: AT,
    finishedAt: AT,
    perSource: {},
    perStage,
    costPence: 0,
    errors: [],
    schemaVersion: 1,
  };
}

describe('funnelText expired counts (ADR-045)', () => {
  it('shows expired apart from skips for S2 and S3', () => {
    const text = funnelText(runWith({ s2, s3 }));
    expect(text).toContain('S2 3 passed, 4 skipped, 1 expired');
    expect(text).toContain('1 skip, 2 expired');
  });

  it('leaves expired out when it is 0', () => {
    const text = funnelText(runWith({ s2: { ...s2, expired: 0 }, s3: { ...s3, expired: 0 } }));
    expect(text).toContain('S2 3 passed, 4 skipped ·');
    expect(text).toContain('1 skip ·');
    expect(text).not.toContain('expired');
  });
});
