import { JOB_LIMITS, normaliseRawJob, type NormalisedJob } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { planAttachment } from './attach.js';
import { testJob, TEST_NOW } from './testing.js';

function basePosting(): NormalisedJob {
  const posting = normaliseRawJob({
    sourceId: 'greenhouse',
    externalId: '5551234',
    url: 'https://job-boards.greenhouse.io/acmeanalytics/jobs/5551234',
    title: 'Product Analyst',
    company: 'Acme Analytics',
    locationText: 'London, UK',
    postedAt: new Date('2026-09-28T09:00:00Z'),
    description: { kind: 'full', format: 'text', body: 'The full posting text.' },
  });
  if (!posting) throw new Error('fixture does not normalise');
  return posting;
}

const posting = (patch: Partial<NormalisedJob> = {}): NormalisedJob => ({
  ...basePosting(),
  ...patch,
});

describe('planAttachment', () => {
  it('adds the posting’s text, source, keys and, when the job has none, its date', () => {
    const job = testJob({
      keys: ['linkedin:4012345678'],
      sources: [
        {
          id: 'linkedin-alert',
          url: 'https://www.linkedin.com/jobs/view/4012345678',
          externalId: '4012345678',
          seenAt: TEST_NOW,
        },
      ],
    });
    delete job.postedAt;
    const plan = planAttachment(job, posting(), TEST_NOW);
    expect(plan.description).toMatchObject({
      text: 'The full posting text.',
      kind: 'full',
      sourceId: 'greenhouse',
    });
    expect(plan.addSources).toHaveLength(1);
    expect(plan.addSources[0]).toMatchObject({ id: 'greenhouse', externalId: '5551234' });
    expect(plan.addKeys).toContain('greenhouse:5551234');
    expect(plan.addKeys).not.toContain('linkedin:4012345678');
    expect(plan.postedAt).toEqual(new Date('2026-09-28T09:00:00Z'));
  });

  it('keeps a posting date the job already has, and a source it already holds', () => {
    const job = testJob({ postedAt: new Date('2026-09-01T00:00:00Z') });
    const withSource = {
      ...job,
      sources: [
        {
          id: 'greenhouse' as const,
          url: 'https://job-boards.greenhouse.io/acmeanalytics/jobs/5551234',
          externalId: '5551234',
          seenAt: TEST_NOW,
        },
      ],
    };
    const plan = planAttachment(withSource, posting(), TEST_NOW);
    expect(plan.postedAt).toBeUndefined();
    expect(plan.addSources).toEqual([]);
  });

  it('never pushes a job past its key and source limits', () => {
    const keys = Array.from({ length: JOB_LIMITS.keys - 1 }, (_, i) => `k:${String(i)}`);
    const plan = planAttachment(testJob({ keys }), posting(), TEST_NOW);
    expect(plan.addKeys).toHaveLength(1);
    const full = planAttachment(
      testJob({ keys: Array.from({ length: JOB_LIMITS.keys }, (_, i) => `k:${String(i)}`) }),
      posting(),
      TEST_NOW,
    );
    expect(full.addKeys).toEqual([]);
    const sources = Array.from({ length: JOB_LIMITS.sources }, (_, i) => ({
      id: 'hn' as const,
      url: 'https://news.ycombinator.com/item?id=1',
      externalId: String(i),
      seenAt: TEST_NOW,
    }));
    expect(planAttachment(testJob({ sources }), posting(), TEST_NOW).addSources).toEqual([]);
  });
});
