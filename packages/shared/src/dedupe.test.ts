import { describe, expect, it } from 'vitest';

import {
  buildNewJob,
  cappedKeys,
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
    sourceCount: 1,
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
    const older = {
      id: 'job-old',
      keys: ['linkedin:4012345678'],
      firstSeenAt: new Date(0),
      sourceCount: 1,
    };
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

  it('adds no source to a job already at the source limit', () => {
    const full = { ...existingGreenhouse, sourceCount: 20 };
    const plan = planIngest(dedupeBatch([norm(LINKEDIN_ALERT_JOB)]), [full]);
    expect(plan.updates).toEqual([]);
    expect(plan.counts).toMatchObject({ duplicate: 1, merged: 0 });
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

describe('cappedKeys (JOB_LIMITS.keys)', () => {
  it("keeps every member's source key and the dedupe key when truncating", () => {
    const [group] = dedupeBatch([norm(GREENHOUSE_JOB), norm(LINKEDIN_ALERT_JOB)]);
    if (!group) throw new Error('no group');
    // 70 URL-derived keys that sort before the real ones would push them out of a plain slice.
    const noise = Array.from({ length: 70 }, (_, i) => `aaa:${String(i).padStart(2, '0')}`);
    const crowded = { ...group, keys: [...noise, ...group.keys].sort() };
    const { keys, dropped } = cappedKeys(crowded);
    expect(keys).toHaveLength(60);
    expect(dropped).toBe(crowded.keys.length - 60);
    expect(keys.slice(0, 2)).toEqual(['greenhouse:5551234', 'linkedin:4012345678']);
    expect(keys.filter((key) => key.startsWith('d:'))).toHaveLength(1);
    expect(buildNewJob(crowded, 'x', NOW).droppedKeys).toBe(dropped);
  });

  it("adds a merged posting's own source key first when the stored job is near the cap", () => {
    const nearlyFull = {
      id: 'job-full',
      keys: [
        norm(GREENHOUSE_JOB).dedupeKey ?? '',
        ...Array.from({ length: 58 }, (_, i) => `x:${String(i)}`),
      ],
      firstSeenAt: new Date(0),
      sourceCount: 1,
    };
    const plan = planIngest(dedupeBatch([norm(LINKEDIN_ALERT_JOB)]), [nearlyFull]);
    expect(plan.updates[0]?.addKeys).toEqual(['linkedin:4012345678']);
  });
});

describe('Easy Apply and alert links on the source ref (ADR-047)', () => {
  const alert = rawJob({
    ...LINKEDIN_ALERT_JOB,
    description: { kind: 'none', format: 'text', body: '' },
    easyApply: true,
  });

  it('carries easyApply from the posting to the source ref of a new job', () => {
    const [group] = dedupeBatch([norm(alert)]);
    if (!group) throw new Error('no group');
    const { job } = buildNewJob(group, 'jobs/x/description/raw', NOW);
    expect(job.sources[0]).toMatchObject({ id: 'linkedin-alert', easyApply: true });
  });

  it('keeps easyApply on its own source when merged into an ATS job', () => {
    const groups = dedupeBatch([norm(alert)]);
    const existing = [
      {
        id: 'job-gh',
        keys: ['greenhouse:5551234', ...norm(GREENHOUSE_JOB).keys],
        firstSeenAt: NOW,
        sourceCount: 1,
      },
    ];
    const plan = planIngest(groups, existing);
    expect(plan.updates).toHaveLength(1);
    const added = plan.updates[0]?.addSources[0];
    expect(added?.easyApply).toBe(true);
    expect(added && sourceRefOf(added)).toMatchObject({ id: 'linkedin-alert', easyApply: true });
  });

  it('marks an unverified link on the source ref only, and gives it no keys of its own', () => {
    const raw = rawJob({
      sourceId: 'email-alert',
      externalId: 'abcd1234abcd1234',
      url: 'https://www.linkedin.com/jobs/search/?keywords=quill',
      unverifiedUrl: 'https://click.example.net/c/9f8e7d',
    });
    const job = norm(raw);
    expect(job.unverifiedUrl).toBe('https://click.example.net/c/9f8e7d');
    expect(job.keys.filter((key) => !key.startsWith('d:'))).toEqual(['email:abcd1234abcd1234']);
    expect(sourceRefOf(job)).toMatchObject({
      id: 'email-alert',
      url: 'https://click.example.net/c/9f8e7d',
      unverified: true,
    });
    expect(buildJobUrl(job)).toBe('https://www.linkedin.com/jobs/search?keywords=quill');
  });
});

function buildJobUrl(job: NormalisedJob) {
  const [group] = dedupeBatch([job]);
  if (!group) throw new Error('no group');
  return buildNewJob(group, 'jobs/x/description/raw', NOW).job.url;
}

function sourceRefOf(job: NormalisedJob) {
  const [group] = dedupeBatch([job]);
  if (!group) throw new Error('no group');
  return buildNewJob(group, 'jobs/x/description/raw', NOW).job.sources[0];
}

describe('description upgrade on merge (ADR-048)', () => {
  const alert = norm(
    rawJob({
      ...LINKEDIN_ALERT_JOB,
      description: { kind: 'none', format: 'text', body: '' },
      postedAt: undefined as never,
    }),
  );
  const greenhouse = norm(GREENHOUSE_JOB);
  const waiting = {
    id: 'job-alert',
    keys: alert.keys,
    firstSeenAt: NOW,
    sourceCount: 1,
    descriptionKind: 'none' as const,
    next: 'description' as const,
  };

  it('writes the full text, the posting date and releases the job to S3', () => {
    const plan = planIngest(dedupeBatch([greenhouse]), [waiting]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]?.upgrade).toEqual({
      text: greenhouse.description.text,
      sourceId: 'greenhouse',
      postedAt: greenhouse.postedAt,
      release: true,
    });
  });

  it('does not release a job that is not waiting for a description', () => {
    const plan = planIngest(dedupeBatch([greenhouse]), [{ ...waiting, next: 's2' as const }]);
    expect(plan.updates[0]?.upgrade).toMatchObject({ release: false });
  });

  it('keeps a posting date the job already has', () => {
    const plan = planIngest(dedupeBatch([greenhouse]), [
      { ...waiting, postedAt: new Date('2026-09-01T00:00:00Z') },
    ]);
    expect(plan.updates[0]?.upgrade?.postedAt).toBeUndefined();
  });

  it('upgrades a snippet-only job too', () => {
    const plan = planIngest(dedupeBatch([greenhouse]), [
      { ...waiting, descriptionKind: 'snippet' },
    ]);
    expect(plan.updates[0]?.upgrade).toBeDefined();
  });

  it('leaves a job that already has full text alone (the other order)', () => {
    const plan = planIngest(dedupeBatch([alert]), [
      {
        id: 'job-gh',
        keys: greenhouse.keys,
        firstSeenAt: NOW,
        sourceCount: 1,
        descriptionKind: 'full' as const,
        next: 's2' as const,
      },
    ]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]?.upgrade).toBeUndefined();
    expect(plan.updates[0]?.addSources[0]?.sourceId).toBe('linkedin-alert');
  });

  it('keeps a waiting job waiting when the new source is snippet-only', () => {
    const snippet = norm(
      rawJob({
        sourceId: 'adzuna',
        externalId: '99',
        description: { kind: 'snippet', format: 'text', body: 'A snippet.' },
      }),
    );
    const plan = planIngest(dedupeBatch([snippet]), [waiting]);
    expect(plan.updates[0]?.upgrade).toBeUndefined();
  });
});
