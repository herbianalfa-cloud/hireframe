import { describe, expect, it } from 'vitest';

import { EventSchema } from './events.js';

const base = { jobId: 'job-1', at: new Date('2026-10-14T09:00:00Z'), schemaVersion: 1 };

describe('EventSchema', () => {
  it('accepts a status change and a feedback event', () => {
    expect(
      EventSchema.safeParse({ ...base, type: 'job_status', from: 'new', to: 'applied' }).success,
    ).toBe(true);
    expect(
      EventSchema.safeParse({
        ...base,
        type: 'job_feedback',
        agree: false,
        verdict: 'apply',
        expected: 'near_miss',
      }).success,
    ).toBe(true);
  });

  it('rejects a status the app cannot set, and unknown types', () => {
    expect(
      EventSchema.safeParse({ ...base, type: 'job_status', from: 'new', to: 'offer' }).success,
    ).toBe(false);
    expect(EventSchema.safeParse({ ...base, type: 'other' }).success).toBe(false);
  });
});
