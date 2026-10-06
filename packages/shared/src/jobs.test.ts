import { describe, expect, it } from 'vitest';

import {
  CLIENT_JOB_STATUSES,
  isRunStalled,
  JOB_STATUSES,
  JobFeedbackSchema,
  JobKeysProjectionSchema,
  JobSourceRefSchema,
  STALE_RUN_MS,
} from './jobs.js';

describe('isRunStalled', () => {
  const startedAt = new Date('2026-10-03T08:00:00Z');
  const at = (ms: number) => new Date(startedAt.getTime() + ms);

  it('marks a run still running past the callable timeout as stalled', () => {
    expect(STALE_RUN_MS).toBe(600_000);
    expect(isRunStalled({ status: 'running', startedAt }, at(STALE_RUN_MS - 1))).toBe(false);
    expect(isRunStalled({ status: 'running', startedAt }, at(STALE_RUN_MS))).toBe(true);
    expect(isRunStalled({ status: 'failed', startedAt }, at(STALE_RUN_MS * 2))).toBe(false);
  });
});

describe('JobKeysProjectionSchema', () => {
  it('rejects a job without keys or a first-seen date', () => {
    const good = { keys: ['d:1'], firstSeenAt: new Date(), sources: [{}] };
    expect(JobKeysProjectionSchema.safeParse(good).success).toBe(true);
    expect(JobKeysProjectionSchema.safeParse({ ...good, keys: [] }).success).toBe(false);
    expect(JobKeysProjectionSchema.safeParse({ ...good, firstSeenAt: 'x' }).success).toBe(false);
  });
});

describe('JobFeedbackSchema', () => {
  const feedback = { agree: false, verdict: 'apply', at: new Date('2026-10-14T09:00:00Z') };

  it('takes an optional note up to 280 characters and an expected verdict', () => {
    expect(JobFeedbackSchema.safeParse(feedback).success).toBe(true);
    expect(
      JobFeedbackSchema.safeParse({ ...feedback, note: 'x'.repeat(280), expected: 'near_miss' })
        .success,
    ).toBe(true);
    expect(JobFeedbackSchema.safeParse({ ...feedback, note: 'x'.repeat(281) }).success).toBe(false);
    expect(JobFeedbackSchema.safeParse({ ...feedback, verdict: 'maybe' }).success).toBe(false);
  });

  it('keeps the client statuses a subset of the job statuses', () => {
    for (const status of CLIENT_JOB_STATUSES) expect(JOB_STATUSES).toContain(status);
    expect(CLIENT_JOB_STATUSES).toEqual(['new', 'saved', 'applied', 'skipped']);
  });
});

describe('JobSourceRefSchema', () => {
  const ref = {
    id: 'email-alert' as const,
    url: 'https://click.example.net/c/9',
    externalId: 'abcd1234abcd1234',
    seenAt: new Date('2026-10-01T08:00:00Z'),
  };

  it('accepts an unverified link only over https', () => {
    expect(JobSourceRefSchema.safeParse({ ...ref, unverified: true }).success).toBe(true);
    expect(
      JobSourceRefSchema.safeParse({
        ...ref,
        url: 'http://click.example.net/c/9',
        unverified: true,
      }).success,
    ).toBe(false);
    expect(
      JobSourceRefSchema.safeParse({
        ...ref,
        url: 'HTTP://click.example.net/c/9',
        unverified: true,
      }).success,
    ).toBe(false);
  });

  it('still accepts a verified http link (an allow-listed source may serve one)', () => {
    expect(
      JobSourceRefSchema.safeParse({ ...ref, url: 'http://boards.example.com/1' }).success,
    ).toBe(true);
  });
});
