import { JobSchema } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { makeView } from '@/features/jobs/fixtures';

import { withFeedback, withStatus } from './job-optimistic';

const AT = new Date('2026-10-15T08:00:00Z');

describe('withStatus', () => {
  it('stamps applied time and verdict, like the write does', () => {
    const next = withStatus(makeView('a'), 'applied', AT);
    expect(next.job).toMatchObject({
      status: 'applied',
      appliedAt: AT,
      appliedVerdict: 'apply',
      updatedAt: AT,
    });
    expect(next.raw.status).toBe('applied');
    expect(JobSchema.safeParse(next.job).success).toBe(true);
  });

  it('clears the applied stamps when leaving applied', () => {
    const applied = withStatus(makeView('a'), 'applied', AT);
    const back = withStatus(applied, 'new', AT);
    expect(back.job.status).toBe('new');
    expect('appliedAt' in back.job).toBe(false);
    expect('appliedVerdict' in back.job).toBe(false);
    expect('appliedAt' in back.raw).toBe(false);
  });

  it('does not change the view it was given', () => {
    const view = makeView('a');
    withStatus(view, 'saved', AT);
    expect(view.job.status).toBe('new');
  });
});

describe('withFeedback', () => {
  it('records the rating on the verdict it judged, trimming the note', () => {
    const next = withFeedback(
      makeView('a'),
      { agree: false, note: '  too senior ', expected: 'skip' },
      AT,
    );
    expect(next.job.feedback).toEqual({
      agree: false,
      verdict: 'apply',
      note: 'too senior',
      expected: 'skip',
      at: AT,
    });
    expect(JobSchema.safeParse(next.job).success).toBe(true);
  });

  it('drops an expected verdict from a 👍, and replaces an earlier rating', () => {
    const wrong = withFeedback(makeView('a'), { agree: false, expected: 'skip' }, AT);
    const right = withFeedback(wrong, { agree: true, expected: 'skip' }, AT);
    expect(right.job.feedback).toEqual({ agree: true, verdict: 'apply', at: AT });
  });
});
