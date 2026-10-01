import { describe, expect, it } from 'vitest';

import {
  buildNewJob,
  dedupeBatch,
  dedupeKey,
  fnv1a64,
  normaliseRawJob,
  planIngest,
  type NormalisedJob,
} from './dedupe.js';
import {
  ADZUNA_SALARY_JOB,
  GREENHOUSE_JOB,
  HN_LINKING_JOB,
  JUNIOR_JOB,
  LINKEDIN_ALERT_JOB,
  NOISY_TITLE_JOB,
  OTHER_CITY_JOB,
  PLAIN_TITLE_JOB,
  rawJob,
  SENIOR_JOB,
} from './fixtures/jobs.js';
import { JobDescriptionSchema, JobSchema, type RawJob } from './jobs.js';

const NOW = new Date('2026-10-01T08:00:00Z');

function norm(raw: RawJob): NormalisedJob {
  const job = normaliseRawJob(raw);
  if (!job) throw new Error('fixture did not normalise');
  return job;
}

function groupsOf(...raws: RawJob[]) {
  return dedupeBatch(raws.map(norm)).map((group) => group.jobs.map((job) => job.sourceKey));
}

describe('fnv1a64', () => {
  it('matches the reference vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });
});

describe('dedupeKey', () => {
  it('is null without a usable company or title', () => {
    expect(dedupeKey('!!!', 'Product Analyst', 'london')).toBeNull();
    expect(dedupeKey('Acme', '---', 'london')).toBeNull();
  });
});

describe('normaliseRawJob', () => {
  it('collects the source key, URL keys and dedupe key, and converts HTML', () => {
    const job = norm(GREENHOUSE_JOB);
    expect(job.url).toBe('https://job-boards.greenhouse.io/acmeanalytics/jobs/5551234');
    expect(job.keys).toContain('greenhouse:5551234');
    expect(job.keys.filter((key) => key.startsWith('d:'))).toHaveLength(1);
    expect(job.description.text).toBe('Join Acme Analytics.\n\n• SQL\n• Dashboards');
    expect(job).toMatchObject({ city: 'london', country: 'GB', companyId: 'acme-analytics' });
  });

  it('rejects a job whose URL is not http(s)', () => {
    expect(normaliseRawJob({ ...GREENHOUSE_JOB, url: 'ftp://example.com/job' })).toBeNull();
  });
});

describe('dedupeBatch (PRD R5, ADR-030)', () => {
  it('collapses the LinkedIn alert and the Greenhouse listing of the same role', () => {
    const groups = dedupeBatch([norm(LINKEDIN_ALERT_JOB), norm(GREENHOUSE_JOB)]);
    expect(groups).toHaveLength(1);
    // The ATS listing leads: it has the full text.
    expect(groups[0]?.jobs.map((job) => job.sourceId)).toEqual(['greenhouse', 'linkedin-alert']);
    expect(groups[0]?.keys).toEqual(
      expect.arrayContaining(['greenhouse:5551234', 'linkedin:4012345678']),
    );
  });

  it('keeps a Senior and a Junior role at the same company apart', () => {
    expect(groupsOf(SENIOR_JOB, JUNIOR_JOB)).toHaveLength(2);
  });

  it('merges a title with location and work-mode noise into the plain title', () => {
    expect(groupsOf(NOISY_TITLE_JOB, PLAIN_TITLE_JOB)).toHaveLength(1);
  });

  it('keeps the same role in another city apart', () => {
    expect(groupsOf(GREENHOUSE_JOB, OTHER_CITY_JOB)).toHaveLength(2);
  });

  it('merges an aggregator title with salary noise', () => {
    expect(groupsOf(GREENHOUSE_JOB, ADZUNA_SALARY_JOB)).toHaveLength(1);
  });

  it('merges a posting that links the job, whatever its title', () => {
    expect(groupsOf(HN_LINKING_JOB, GREENHOUSE_JOB)).toEqual([
      ['greenhouse:5551234', 'hn:41000001'],
    ]);
  });

  it('joins chains: A~B by URL and B~C by dedupe key', () => {
    expect(groupsOf(HN_LINKING_JOB, GREENHOUSE_JOB, LINKEDIN_ALERT_JOB)).toHaveLength(1);
  });

  it('keeps unrelated jobs apart and in input order', () => {
    expect(groupsOf(SENIOR_JOB, GREENHOUSE_JOB, JUNIOR_JOB)).toEqual([
      ['lever:0b1c2d3e-0000-4000-8000-000000000001'],
      ['greenhouse:5551234'],
      ['lever:0b1c2d3e-0000-4000-8000-000000000002'],
    ]);
  });
});

describe('planIngest', () => {
  const existingGreenhouse = {
    id: 'job-gh',
    keys: norm(GREENHOUSE_JOB).keys,
    firstSeenAt: new Date('2026-09-20T00:00:00Z'),
  };

  it('creates jobs nothing stored matches', () => {
    const plan = planIngest(dedupeBatch([norm(GREENHOUSE_JOB), norm(LINKEDIN_ALERT_JOB)]), []);
    expect(plan.creates).toHaveLength(1);
    expect(plan.updates).toEqual([]);
    expect(plan.outcomes).toEqual([
      { sourceId: 'greenhouse', outcome: 'new' },
      { sourceId: 'linkedin-alert', outcome: 'merged' },
    ]);
    expect(plan.counts).toEqual({ in: 2, new: 1, merged: 1, duplicate: 0, conflicts: 0 });
  });

  it('writes nothing for a job seen before from the same source', () => {
    const plan = planIngest(dedupeBatch([norm(GREENHOUSE_JOB)]), [existingGreenhouse]);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.counts).toMatchObject({ in: 1, duplicate: 1 });
  });

  it('adds a new source to a stored job (the LinkedIn alert arrives later)', () => {
    const plan = planIngest(dedupeBatch([norm(LINKEDIN_ALERT_JOB)]), [existingGreenhouse]);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]?.jobId).toBe('job-gh');
    expect(plan.updates[0]?.addSources.map((job) => job.sourceId)).toEqual(['linkedin-alert']);
    expect(plan.updates[0]?.addKeys).toContain('linkedin:4012345678');
    expect(plan.updates[0]?.addKeys).not.toContain('greenhouse:5551234');
    expect(plan.counts).toMatchObject({ merged: 1, new: 0 });
  });

  it('joins the job seen first when a group matches two stored jobs, and counts a conflict', () => {
    const older = { id: 'job-old', keys: ['linkedin:4012345678'], firstSeenAt: new Date(0) };
    const plan = planIngest(dedupeBatch([norm(GREENHOUSE_JOB), norm(LINKEDIN_ALERT_JOB)]), [
      existingGreenhouse,
      older,
    ]);
    expect(plan.counts.conflicts).toBe(1);
    expect(plan.updates.map((update) => update.jobId)).toEqual(['job-old']);
    expect(plan.outcomes.map((o) => o.outcome)).toEqual(['merged', 'duplicate']);
  });

  it('merges two groups that hit the same stored job into one update', () => {
    const plan = planIngest(
      dedupeBatch([norm(LINKEDIN_ALERT_JOB)]).concat(dedupeBatch([norm(HN_LINKING_JOB)])),
      [existingGreenhouse],
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]?.addSources.map((job) => job.sourceId)).toEqual([
      'linkedin-alert',
      'hn',
    ]);
  });

  it('counts the same posting twice in one run as a duplicate', () => {
    const plan = planIngest(dedupeBatch([norm(GREENHOUSE_JOB), norm(GREENHOUSE_JOB)]), []);
    expect(plan.outcomes.map((o) => o.outcome)).toEqual(['new', 'duplicate']);
  });
});

describe('buildNewJob', () => {
  it('builds valid documents from the full-text member', () => {
    const [group] = dedupeBatch([norm(LINKEDIN_ALERT_JOB), norm(GREENHOUSE_JOB)]);
    if (!group) throw new Error('no group');
    const { job, description } = buildNewJob(group, 'jobs/j1/description/raw', NOW);
    expect(JobSchema.parse(job)).toEqual(job);
    expect(JobDescriptionSchema.parse(description)).toEqual(description);
    expect(job).toMatchObject({
      title: 'Product Analyst',
      company: 'Acme Analytics',
      companyId: 'acme-analytics',
      stage: 's0',
      status: 'new',
      descriptionKind: 'full',
      firstSeenAt: NOW,
    });
    expect(job.sources.map((source) => source.id)).toEqual(['greenhouse', 'linkedin-alert']);
    expect(job).not.toHaveProperty('criteriaVersion');
    expect(description.sourceId).toBe('greenhouse');
  });

  it('falls back to the source key when there is no dedupe key', () => {
    const [group] = dedupeBatch([norm(rawJob({ sourceId: 'hn', externalId: '1', company: '!!' }))]);
    if (!group) throw new Error('no group');
    expect(buildNewJob(group, 'x', NOW).job.dedupeKey).toBe('hn:1');
  });
});
