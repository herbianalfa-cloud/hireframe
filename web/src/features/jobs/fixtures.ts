import type { Job } from '@hireframe/shared';

import type { JobView } from '@/services/jobs';

/** Fake jobs for tests: no real companies, people or postings. */
export const NOW = new Date('2026-10-14T12:00:00Z');

export function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    dedupeKey: 'acme|data analyst|london',
    keys: ['acme|data analyst|london'],
    title: 'Data Analyst',
    company: 'Acme Test Co',
    location: 'London, UK',
    city: 'london',
    country: 'GB',
    remote: 'hybrid',
    url: 'https://jobs.example.test/acme/1',
    sources: [
      {
        id: 'greenhouse',
        url: 'https://jobs.example.test/acme/1',
        externalId: '1',
        seenAt: new Date('2026-10-12T09:00:00Z'),
      },
    ],
    postedAt: new Date('2026-10-11T09:00:00Z'),
    firstSeenAt: new Date('2026-10-12T09:00:00Z'),
    descriptionRef: 'description/raw',
    descriptionKind: 'full',
    stage: 's3',
    status: 'new',
    verdict: 'apply',
    fitScore: 8.2,
    luckScore: 7.1,
    reason: 'Strong match on SQL reporting and stakeholder work.',
    judgedAt: new Date('2026-10-14T07:40:00Z'),
    createdAt: new Date('2026-10-12T09:00:00Z'),
    updatedAt: new Date('2026-10-14T07:40:00Z'),
    schemaVersion: 1,
    ...overrides,
  };
}

export function makeView(id: string, overrides: Partial<Job> = {}): JobView {
  const job = makeJob(overrides);
  return { id, job, raw: { status: job.status, verdict: job.verdict } };
}

const JUDGED_FIELDS = ['verdict', 'fitScore', 'luckScore', 'reason', 'judgedAt'];

/** A job with no verdict yet (waiting or queued): the judged fields are left off. */
export function makeUnjudgedView(id: string, overrides: Partial<Job> = {}): JobView {
  const job = makeJob(overrides);
  for (const field of JUDGED_FIELDS) {
    if (!(field in overrides)) Reflect.deleteProperty(job, field);
  }
  return { id, job, raw: { status: job.status } };
}
